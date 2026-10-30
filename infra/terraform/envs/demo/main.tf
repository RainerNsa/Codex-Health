# demo: a synthetic-data demonstration of Codex Health in ONE account, sized for free-plan credits (decision log
# 2026-10-30). Not the production design (envs/dev|test|prod): no private network or VPC endpoints, no NAT, no
# separate audit-anchor account, Postgres on the server instead of RDS, and the local sign-in stand-in behind a
# password gate instead of Cognito. What it keeps: KMS-encrypted documents in the hardened storage module, the
# app's own row-level security and audit chain, HTTPS on CloudFront, and a server that answers only CloudFront.
#
#   browser ──HTTPS──▶ CloudFront ── password gate (CloudFront Function) ──┬─▶ S3: the web app (private, OAC)
#                                                                          └─▶ /api/* ─▶ EC2 :3000 (CloudFront's
#   browser ──signed PUT──▶ S3 documents bucket (KMS, quarantine/, CORS for this origin only)     IP ranges only, plus
#                                                                                                 an origin secret)

data "aws_caller_identity" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  docs_bucket  = "codex-health-demo-docs-${local.account_id}"
  web_bucket   = "codex-health-demo-web-${local.account_id}"
  demo_host    = "${var.demo_subdomain}.${var.domain_name}"
  demo_origin  = "https://${local.demo_host}"
  gate_b64     = base64encode("${var.gate_username}:${var.gate_password}")
  origin_value = random_password.origin_secret.result
}

resource "random_password" "origin_secret" {
  length  = 48
  special = false
}

# --- network: the account's default VPC, one public subnet ----------------------------------------------------
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "server" {
  name        = "codex-health-demo-server"
  description = "Codex Health demo server: the API port from CloudFront only; no SSH (Session Manager instead)"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "API, from CloudFront's origin-facing ranges only"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }

  egress {
    description = "Package installs, GitHub, nodejs.org and AWS APIs"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- the server's identity --------------------------------------------------------------------------------------
data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "server" {
  name               = "codex-health-demo-server"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.server.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "server" {
  statement {
    sid       = "DocumentsObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:GetObjectVersion", "s3:DeleteObjectVersion"]
    resources = ["${module.storage.bucket_arn}/*"]
  }
  statement {
    sid       = "WebAppPublish"
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.web.arn, "${aws_s3_bucket.web.arn}/*"]
  }
  statement {
    sid       = "DocumentsKey"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [module.kms.key_arn]
  }
}

resource "aws_iam_role_policy" "server" {
  name   = "codex-health-demo-server"
  role   = aws_iam_role.server.id
  policy = data.aws_iam_policy_document.server.json
}

resource "aws_iam_instance_profile" "server" {
  name = "codex-health-demo-server"
  role = aws_iam_role.server.name
}

# --- documents: the hardened storage module (KMS, versioning, quarantine expiry, CORS for this origin) -----------
module "kms" {
  source = "../../modules/kms"

  environment             = "demo"
  user_role_arns          = [aws_iam_role.server.arn]
  deletion_window_in_days = 7
}

module "storage" {
  source = "../../modules/storage"

  bucket_name    = local.docs_bucket
  kms_key_arn    = module.kms.key_arn
  retention_days = 30
  # the server, and whoever runs Terraform (an IAM user here): the bucket denies everyone else, and `terraform
  # destroy` must be able to empty it
  principal_role_arns = [aws_iam_role.server.arn, data.aws_caller_identity.current.arn]
  force_destroy       = true
  upload_origins      = [local.demo_origin]
}

# --- the web app: a private bucket only CloudFront reads --------------------------------------------------------
resource "aws_s3_bucket" "web" {
  bucket        = local.web_bucket
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "web" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.demo.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.web.json
}

# --- the server ------------------------------------------------------------------------------------------------
data "aws_ssm_parameter" "al2023_arm" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_instance" "server" {
  ami                         = data.aws_ssm_parameter.al2023_arm.value
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnets.default.ids[0]
  vpc_security_group_ids      = [aws_security_group.server.id]
  iam_instance_profile        = aws_iam_instance_profile.server.name
  associate_public_ip_address = true

  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1 # the Postgres container never reaches the instance role
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
  }

  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    repo_ref      = var.repo_ref
    node_version  = var.node_version
    region        = var.region
    docs_bucket   = local.docs_bucket
    docs_key_arn  = module.kms.key_arn
    web_bucket    = local.web_bucket
    origin_secret = local.origin_value
  })

  tags = { Name = "codex-health-demo" }

  lifecycle {
    ignore_changes = [ami] # a newer AMI does not rebuild the demo; change repo_ref to redeploy
    # the documents bucket admits only listed principals by aws:PrincipalArn; an assumed role (SSO) never matches
    # its session ARN, so `destroy` could not empty the bucket. The setup guide uses an IAM admin user.
    precondition {
      condition     = can(regex(":user/", data.aws_caller_identity.current.arn))
      error_message = "Run Terraform as an IAM user (the setup guide's codex-admin), not an assumed role or SSO session."
    }
  }
}

# --- the demo's own name and certificate: TLS 1.2+ only (the default *.cloudfront.net certificate cannot refuse
# TLS 1.0/1.1). The domain lives in Route 53 in this account, so validation and the record are automatic. --------
data "aws_route53_zone" "domain" {
  name         = var.domain_name
  private_zone = false
}

resource "aws_acm_certificate" "demo" {
  domain_name       = local.demo_host
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = { for o in aws_acm_certificate.demo.domain_validation_options : o.domain_name => o }

  zone_id = data.aws_route53_zone.domain.zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "demo" {
  certificate_arn         = aws_acm_certificate.demo.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_route53_record" "demo" {
  for_each = toset(["A", "AAAA"])

  zone_id = data.aws_route53_zone.domain.zone_id
  name    = local.demo_host
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.demo.domain_name
    zone_id                = aws_cloudfront_distribution.demo.hosted_zone_id
    evaluate_target_health = false
  }
}

# --- CloudFront: HTTPS, the password gate, the web app and /api/* ------------------------------------------------
resource "aws_cloudfront_function" "gate" {
  name    = "codex-health-demo-gate"
  runtime = "cloudfront-js-2.0"
  publish = true
  comment = "Password gate in front of the whole demo"
  code    = <<-JS
    function handler(event) {
      var auth = event.request.headers.authorization;
      if (!auth || auth.value !== 'Basic ${local.gate_b64}') {
        return { statusCode: 401, statusDescription: 'Unauthorized', headers: { 'www-authenticate': { value: 'Basic realm="Codex Health demo"' } } };
      }
      // CloudFront forwards Authorization to the origin on writes whatever the policy says: never send the gate
      // password on to the server
      delete event.request.headers.authorization;
      return event.request;
    }
  JS
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "codex-health-demo-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_but_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_distribution" "demo" {
  enabled             = true
  comment             = "Codex Health demo (synthetic data only)"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  aliases             = [local.demo_host]
  is_ipv6_enabled     = true

  origin {
    origin_id                = "web"
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    origin_id   = "api"
    domain_name = aws_instance.server.public_dns
    custom_origin_config {
      http_port              = 3000
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
    # the server refuses every request without this header (apps/api/src/server.ts): the gate cannot be skipped
    custom_header {
      name  = "x-codex-origin"
      value = local.origin_value
    }
  }

  default_cache_behavior {
    target_origin_id       = "web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
    compress               = true
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.gate.arn
    }
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_but_host.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.gate.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.demo.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# --- cost alerts --------------------------------------------------------------------------------------------------
module "budgets" {
  source = "../../modules/budgets"

  environment        = "demo"
  monthly_amount_usd = var.monthly_budget_usd
  alert_email        = var.budget_alert_email
  include_credits    = false # the account runs on credits: alert on usage, not on what is left to pay
}

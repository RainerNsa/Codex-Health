# The demo's one server, in its own file: CONSTRAINTS exception EX-1 (the Semgrep EC2 public-IP rule) covers this
# file only, so nothing else added to the demo can take a public address unnoticed. The CloudFront to server hop
# is plain HTTP over the public internet, accepted for synthetic data only (EX-1).

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


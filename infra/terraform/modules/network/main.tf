# Private-only VPC for workers and the database, with VPC endpoints as the ONLY
# way out (dev-alignment 1.11; security.md §2 "egress allowlist ... is what makes
# 'no unapproved AI service' enforceable"). There is no internet gateway and no
# NAT unless allow_nat = true, so a worker holding a hostile PDF cannot reach any
# host that is not an allowlisted AWS endpoint in this region.
#
# Three security groups form the allowlist:
#   workers   egress 443 -> endpoints SG and the S3 gateway prefix list; 5432 -> db SG
#   db        ingress 5432 <- workers SG only
#   endpoints ingress 443  <- workers SG only
# Nothing else. The API tier, load balancer and public subnets arrive with compute
# (see README "deliberately missing"); so do the ecr.api, ecr.dkr and
# secretsmanager endpoints ECS tasks need to pull images and read the DB secret.

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_region" "current" {}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "codex-health-${var.environment}" }
}

resource "aws_subnet" "private" {
  count             = length(var.private_subnet_cidrs)
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = data.aws_availability_zones.available.names[count.index]

  map_public_ip_on_launch = false

  tags = { Name = "codex-health-${var.environment}-private-${count.index}" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "codex-health-${var.environment}-private" }
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# --- security groups ---------------------------------------------------------

resource "aws_security_group" "workers" {
  name        = "codex-health-${var.environment}-workers"
  description = "Pipeline workers: egress only to allowlisted VPC endpoints and the database"
  vpc_id      = aws_vpc.this.id
}

resource "aws_security_group" "db" {
  name        = "codex-health-${var.environment}-db"
  description = "RDS: ingress 5432 from workers only"
  vpc_id      = aws_vpc.this.id
}

resource "aws_security_group" "endpoints" {
  name        = "codex-health-${var.environment}-endpoints"
  description = "Interface VPC endpoints: ingress 443 from workers only"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_egress_rule" "workers_to_endpoints" {
  security_group_id            = aws_security_group.workers.id
  description                  = "HTTPS to interface endpoints (sqs, bedrock-runtime, textract, logs, kms)"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.endpoints.id
}

resource "aws_vpc_security_group_egress_rule" "workers_to_s3" {
  security_group_id = aws_security_group.workers.id
  description       = "HTTPS to the S3 gateway endpoint"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
}

resource "aws_vpc_security_group_egress_rule" "workers_to_db" {
  security_group_id            = aws_security_group.workers.id
  description                  = "Postgres"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.db.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_workers" {
  security_group_id            = aws_security_group.db.id
  description                  = "Postgres from workers"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.workers.id
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_workers" {
  security_group_id            = aws_security_group.endpoints.id
  description                  = "HTTPS from workers"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.workers.id
}

# --- VPC endpoints (the egress allowlist) -----------------------------------

# Every endpoint carries a policy. A security group only says WHICH AWS service
# a worker may reach; the endpoint policy says WHOSE resources, so a worker
# holding a hostile PDF cannot PutObject to an attacker's bucket in another
# account or invoke an unpinned model. Every policy requires
# aws:PrincipalAccount = this account; S3 and Bedrock are further pinned to the
# resource ARNs the environment root passes in. Task roles (M1) narrow actions
# per job; these policies are the ceiling, not the grant.

data "aws_caller_identity" "current" {}

# S3: only the documents bucket and the audit-anchor bucket (another account).
# shortcut: when the ecr.api/ecr.dkr endpoints arrive with compute (M1), image
# layers are pulled from the regional ECR layer bucket through this endpoint and
# that bucket ARN must be added here.
data "aws_iam_policy_document" "s3_endpoint" {
  statement {
    sid     = "OnlyOurBucketsFromThisAccount"
    effect  = "Allow"
    actions = ["s3:*"]
    resources = [
      var.documents_bucket_arn,
      "${var.documents_bucket_arn}/*",
      var.audit_anchor_bucket_arn,
      "${var.audit_anchor_bucket_arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

# Bedrock: invoke only, and only the pinned model / inference profile (I7; the
# pinned id is part of every evaluation's version stamp, I6).
data "aws_iam_policy_document" "bedrock_endpoint" {
  statement {
    sid    = "InvokePinnedModelOnlyFromThisAccount"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = var.bedrock_model_arns

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

# textract, sqs, logs, kms: any action of that one service, from this account only.
data "aws_iam_policy_document" "account_scoped_endpoint" {
  for_each = toset(["sqs", "textract", "logs", "kms"])

  statement {
    sid       = "ThisAccountOnly"
    effect    = "Allow"
    actions   = ["${each.key}:*"]
    resources = ["*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

locals {
  endpoint_policies = merge(
    { for svc, doc in data.aws_iam_policy_document.account_scoped_endpoint : svc => doc.json },
    { "bedrock-runtime" = data.aws_iam_policy_document.bedrock_endpoint.json },
  )
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  policy            = data.aws_iam_policy_document.s3_endpoint.json

  tags = { Name = "codex-health-${var.environment}-s3" }
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset(["sqs", "bedrock-runtime", "textract", "logs", "kms"])

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${data.aws_region.current.name}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  policy              = local.endpoint_policies[each.key]

  tags = { Name = "codex-health-${var.environment}-${each.key}" }
}

# --- optional NAT (off by default) ------------------------------------------
# allow_nat = true opens general internet egress from the private subnets. It
# exists for one-off package pulls during development and must never be true in
# test or prod: it would make the egress allowlist advisory.

resource "aws_internet_gateway" "nat" {
  count  = var.allow_nat ? 1 : 0
  vpc_id = aws_vpc.this.id

  tags = { Name = "codex-health-${var.environment}-nat-igw" }
}

resource "aws_subnet" "nat_public" {
  count             = var.allow_nat ? 1 : 0
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.nat_public_subnet_cidr
  availability_zone = data.aws_availability_zones.available.names[0]

  tags = { Name = "codex-health-${var.environment}-nat-public" }
}

resource "aws_route_table" "nat_public" {
  count  = var.allow_nat ? 1 : 0
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.nat[0].id
  }

  tags = { Name = "codex-health-${var.environment}-nat-public" }
}

resource "aws_route_table_association" "nat_public" {
  count          = var.allow_nat ? 1 : 0
  subnet_id      = aws_subnet.nat_public[0].id
  route_table_id = aws_route_table.nat_public[0].id
}

resource "aws_eip" "nat" {
  count  = var.allow_nat ? 1 : 0
  domain = "vpc"
}

resource "aws_nat_gateway" "this" {
  count         = var.allow_nat ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.nat_public[0].id

  depends_on = [aws_internet_gateway.nat]
}

resource "aws_route" "private_default_via_nat" {
  count                  = var.allow_nat ? 1 : 0
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[0].id
}

resource "aws_vpc_security_group_egress_rule" "workers_to_internet_via_nat" {
  count             = var.allow_nat ? 1 : 0
  security_group_id = aws_security_group.workers.id
  description       = "TEMPORARY general HTTPS egress; only valid while allow_nat = true in dev"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

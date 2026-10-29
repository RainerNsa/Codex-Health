# One customer-managed key per environment (dev-alignment 1.11; security.md §4
# "KMS on every bucket"). S3, RDS, SQS, the RDS-managed master password and the
# log groups all use this key.
#
# Key policy (SPEC §12.2 "account operator" row: "KMS key policies restricted to
# service roles", M1): the account root administers the key and nobody else has
# kms:*; the task roles in user_role_arns get use-only actions; the regional logs
# service may use it for the log groups (modules/logs); and principals of this
# account may use it only THROUGH s3, rds, sqs and secretsmanager (kms:ViaService),
# which is what `terraform apply` needs to create the encrypted bucket, instance,
# queues and master secret. No wildcard principal anywhere.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_root = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
  via_services = [for s in ["s3", "rds", "sqs", "secretsmanager"] : "${s}.${data.aws_region.current.name}.amazonaws.com"]
}

data "aws_iam_policy_document" "key" {
  statement {
    sid       = "AccountRootAdministersKey"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = [local.account_root]
    }
  }

  dynamic "statement" {
    for_each = length(var.user_role_arns) > 0 ? [1] : []
    content {
      sid    = "TaskRolesUseKey"
      effect = "Allow"
      actions = [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:DescribeKey",
      ]
      resources = ["*"]

      principals {
        type        = "AWS"
        identifiers = var.user_role_arns
      }
    }
  }

  statement {
    sid    = "LogsServiceUsesKeyForOurLogGroups"
    effect = "Allow"
    actions = [
      "kms:Encrypt*",
      "kms:Decrypt*",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${data.aws_region.current.name}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/codex-health/${var.environment}/*"]
    }
  }

  statement {
    sid    = "ThisAccountUsesKeyViaServices"
    effect = "Allow"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
      "kms:CreateGrant",
    ]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = [local.account_root]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.via_services
    }
  }
}

resource "aws_kms_key" "this" {
  description             = "Codex Health ${var.environment} data key"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = var.deletion_window_in_days
  multi_region            = false
  policy                  = data.aws_iam_policy_document.key.json
}

resource "aws_kms_alias" "this" {
  name          = "alias/codex-health-${var.environment}"
  target_key_id = aws_kms_key.this.key_id
}

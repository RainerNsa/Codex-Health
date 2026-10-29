# Task roles for the ECS services, roles only; the services, task definitions and
# ECR arrive with the M4 thin slice. One identity per job, each with the least it
# needs (SPEC §12.2 rows "pipeline worker", "queue sender", "account operator";
# decision log 2026-10-29 "split writer and verifier identities").
#
#   api              sends to the processing queue; the only bucket-wide S3
#                    principal, since it issues the signed URLs (SPEC §12.2
#                    "facility staff" row)
#   worker           consumes the queue, calls Textract and the pinned Bedrock
#                    model, and holds NO S3 access of its own
#   worker-session   assumed by the worker once per job (sts:AssumeRole from the
#                    worker role only). Its permission policy allows Get/Put under
#                    documents/* only; the worker MUST pass a session policy
#                    narrowing that to documents/<facility_id>/* for the job's
#                    facility (read from the referral row, never from the
#                    message). The effective permission is the intersection, so
#                    credentials minted for job A are denied B's keys (XF-3).
#   anchor-writer    PutObject + kms:Encrypt/GenerateDataKey on the anchor bucket
#   anchor-verifier  Get/GetVersion/List/ListVersions + kms:Decrypt, never Put
#
# Nothing here may delete an object, call Bedrock beyond InvokeModel /
# InvokeModelWithResponseStream on the pinned model ARNs, or write logs beyond
# CreateLogStream / PutLogEvents on its own group (modules/logs). Use of the
# environment CMK is granted in the key policy (modules/kms), not here; the anchor
# key is in another account, so those two roles carry the kms grant on their side.

data "aws_caller_identity" "current" {}

locals {
  ecs_roles = toset(["api", "worker", "anchor-writer", "anchor-verifier"])
  logs_arns = { for k, arn in var.log_group_arns : k => [arn, "${arn}:*"] }
}

# The SourceAccount condition stops a task in another account assuming our roles
# through the shared service principal (confused deputy).
data "aws_iam_policy_document" "ecs_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "ecs" {
  for_each = local.ecs_roles

  name               = "codex-health-${var.environment}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_trust.json
}

data "aws_iam_policy_document" "worker_session_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.ecs["worker"].arn]
    }
  }
}

resource "aws_iam_role" "worker_session" {
  name                 = "codex-health-${var.environment}-worker-session"
  assume_role_policy   = data.aws_iam_policy_document.worker_session_trust.json
  max_session_duration = 3600
}

# --- Permission policies -------------------------------------------------------

data "aws_iam_policy_document" "api" {
  statement {
    sid       = "SendToProcessingQueue"
    actions   = ["sqs:SendMessage", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"]
    resources = [var.processing_queue_arn]
  }

  statement {
    sid       = "SignedUrlIssuerOnDocuments"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${var.documents_bucket_arn}/documents/*"]
  }

  statement {
    sid       = "OwnLogGroup"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = local.logs_arns["api"]
  }
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid = "ConsumeProcessingQueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueUrl",
      "sqs:GetQueueAttributes",
    ]
    resources = [var.processing_queue_arn]
  }

  statement {
    sid       = "AssumePerJobSession"
    actions   = ["sts:AssumeRole"]
    resources = [aws_iam_role.worker_session.arn]
  }

  statement {
    sid       = "InvokePinnedModelOnly"
    actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = var.bedrock_model_arns
  }

  # Textract has no resource-level permissions.
  statement {
    sid = "Ocr"
    actions = [
      "textract:DetectDocumentText",
      "textract:AnalyzeDocument",
      "textract:StartDocumentTextDetection",
      "textract:GetDocumentTextDetection",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "OwnLogGroup"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = local.logs_arns["worker"]
  }
}

# The ceiling for a job; the session policy the worker passes is the floor.
data "aws_iam_policy_document" "worker_session" {
  statement {
    sid       = "DocumentsPrefixOnly"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${var.documents_bucket_arn}/documents/*"]
  }
}

data "aws_iam_policy_document" "anchor_writer" {
  statement {
    sid       = "WriteAnchors"
    actions   = ["s3:PutObject"]
    resources = ["${var.audit_anchor_bucket_arn}/*"]
  }

  statement {
    sid       = "EncryptWithAnchorKey"
    actions   = ["kms:Encrypt", "kms:GenerateDataKey"]
    resources = [var.audit_anchor_key_arn]
  }

  statement {
    sid       = "OwnLogGroup"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = local.logs_arns["anchor"]
  }
}

data "aws_iam_policy_document" "anchor_verifier" {
  statement {
    sid = "ReadAnchorsAndVersions"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:ListBucketVersions",
    ]
    resources = [var.audit_anchor_bucket_arn, "${var.audit_anchor_bucket_arn}/*"]
  }

  statement {
    sid       = "DecryptWithAnchorKey"
    actions   = ["kms:Decrypt"]
    resources = [var.audit_anchor_key_arn]
  }

  statement {
    sid       = "OwnLogGroup"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = local.logs_arns["anchor"]
  }
}

locals {
  policies = {
    "api"             = data.aws_iam_policy_document.api.json
    "worker"          = data.aws_iam_policy_document.worker.json
    "anchor-writer"   = data.aws_iam_policy_document.anchor_writer.json
    "anchor-verifier" = data.aws_iam_policy_document.anchor_verifier.json
  }
}

resource "aws_iam_role_policy" "ecs" {
  for_each = local.policies

  name   = "least-privilege"
  role   = aws_iam_role.ecs[each.key].id
  policy = each.value
}

resource "aws_iam_role_policy" "worker_session" {
  name   = "least-privilege"
  role   = aws_iam_role.worker_session.id
  policy = data.aws_iam_policy_document.worker_session.json
}

locals {
  roles = {
    api             = aws_iam_role.ecs["api"]
    worker          = aws_iam_role.ecs["worker"]
    worker_session  = aws_iam_role.worker_session
    anchor_writer   = aws_iam_role.ecs["anchor-writer"]
    anchor_verifier = aws_iam_role.ecs["anchor-verifier"]
  }
}

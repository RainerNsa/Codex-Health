# Document-processing queue with a dead-letter queue (master plan stack; dev-alignment
# 1.8 names DLQ messages as a store the deletion job must cover). Both queues are
# KMS-encrypted with the environment CMK.
#
# Payload rule for the worker (services/worker): messages carry ids only
# (referral_id, document_id, facility_id, run_id), never document text or facts.
# A message that sits in the DLQ for 14 days then holds nothing worth purging.

resource "aws_sqs_queue" "dlq" {
  name                              = "codex-health-${var.environment}-processing-dlq"
  visibility_timeout_seconds        = 3600    # a dead letter the worker cannot act on waits for triage without churning
  message_retention_seconds         = 1209600 # 14 days, the maximum, so failures are not lost before triage
  kms_master_key_id                 = var.kms_key_arn
  kms_data_key_reuse_period_seconds = 300
}

resource "aws_sqs_queue" "processing" {
  name                              = "codex-health-${var.environment}-processing"
  visibility_timeout_seconds        = var.visibility_timeout_seconds
  message_retention_seconds         = 345600 # 4 days
  receive_wait_time_seconds         = 20
  kms_master_key_id                 = var.kms_key_arn
  kms_data_key_reuse_period_seconds = 300

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.processing.arn]
  })
}

# --- Queue policy (SPEC §12.2 "Queue sender" row; decision log 2026-10-29) ----
#
# Threat: anyone in the account with sqs:SendMessage forges a message naming
# facility B's key. First control, in the worker: facility_id is derived from
# the referral row the worker owns, never from the message, and a message whose
# key disagrees with the row is dead-lettered (XF-13). This policy is the SECOND
# control: only the API task role may send, only the worker task role may
# receive, delete or change visibility, and everything needs TLS.
#
# Written as Deny statements so IAM policies in the account still grant the
# listed roles their access and an empty list means "nobody yet" (an Allow with
# no principal is invalid; a Deny with no condition is a complete deny). A DLQ
# redrive needs SendMessage on this queue, so an operator redrive is denied
# unless done as a listed sender; that is the §12 "account operator" threat.
data "aws_iam_policy_document" "processing" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [aws_sqs_queue.processing.arn]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenySendExceptSenderRoles"
    effect    = "Deny"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.processing.arn]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    dynamic "condition" {
      for_each = length(var.sender_role_arns) > 0 ? [1] : []
      content {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = var.sender_role_arns
      }
    }
  }

  statement {
    sid    = "DenyConsumeExceptConsumerRoles"
    effect = "Deny"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [aws_sqs_queue.processing.arn]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    dynamic "condition" {
      for_each = length(var.consumer_role_arns) > 0 ? [1] : []
      content {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = var.consumer_role_arns
      }
    }
  }
}

resource "aws_sqs_queue_policy" "processing" {
  queue_url = aws_sqs_queue.processing.id
  policy    = data.aws_iam_policy_document.processing.json
}

# --- Dead-letter queue policy ---------------------------------------------------------------------------------
#
# The worker acts on dead letters, so this queue is an input too. Nobody sends to it: only SQS moves messages here
# (redrive is not an IAM send; confirm on the first real run). Only the worker's role consumes it.
data "aws_iam_policy_document" "dlq" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [aws_sqs_queue.dlq.arn]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyAllSends"
    effect    = "Deny"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }

  statement {
    sid    = "DenyConsumeExceptConsumerRoles"
    effect = "Deny"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [aws_sqs_queue.dlq.arn]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    dynamic "condition" {
      for_each = length(var.consumer_role_arns) > 0 ? [1] : []
      content {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = var.consumer_role_arns
      }
    }
  }
}

resource "aws_sqs_queue_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id
  policy    = data.aws_iam_policy_document.dlq.json
}

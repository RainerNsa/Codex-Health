# Document-processing queue with a dead-letter queue (master plan stack; dev-alignment
# 1.8 names DLQ messages as a store the deletion job must cover). Both queues are
# KMS-encrypted with the environment CMK.
#
# Payload rule for the worker (services/worker): messages carry ids only
# (referral_id, document_id, facility_id, run_id), never document text or facts.
# A message that sits in the DLQ for 14 days then holds nothing worth purging.

resource "aws_sqs_queue" "dlq" {
  name                              = "codex-health-${var.environment}-processing-dlq"
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

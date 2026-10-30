output "processing_queue_url" {
  value = aws_sqs_queue.processing.id
}

output "processing_queue_arn" {
  value = aws_sqs_queue.processing.arn
}

output "dlq_arn" {
  value = aws_sqs_queue.dlq.arn
}

output "dlq_url" {
  value = aws_sqs_queue.dlq.url
}

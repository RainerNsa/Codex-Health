output "log_group_arns" {
  description = "Log group ARN per task name (api, worker, anchor), for the task roles' logs permissions."
  value       = { for k, g in aws_cloudwatch_log_group.this : k => g.arn }
}

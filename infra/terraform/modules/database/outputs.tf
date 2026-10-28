output "endpoint" {
  description = "host:port of the instance; private, reachable only from the workers security group."
  value       = aws_db_instance.this.endpoint
}

output "master_user_secret_arn" {
  description = "Secrets Manager ARN of the RDS-managed master password. Application roles get their own, lesser credentials in packages/db."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

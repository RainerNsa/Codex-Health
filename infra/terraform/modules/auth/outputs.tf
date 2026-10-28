output "user_pool_id" {
  value = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  value = aws_cognito_user_pool.this.arn
}

output "web_client_id" {
  description = "Public client id (no secret); safe to ship in the web bundle."
  value       = aws_cognito_user_pool_client.web.id
}

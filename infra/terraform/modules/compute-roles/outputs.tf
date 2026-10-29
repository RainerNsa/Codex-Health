output "role_arns" {
  description = "Role ARN by key: api, worker, worker_session, anchor_writer, anchor_verifier."
  value       = { for k, r in local.roles : k => r.arn }
}

output "role_names" {
  description = "Role name by the same keys as role_arns."
  value       = { for k, r in local.roles : k => r.name }
}

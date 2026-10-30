output "demo_url" {
  description = "Open this, sign in at the gate, then pick a ZZTEST user."
  value       = local.demo_origin
}

output "gate_username" {
  value = var.gate_username
}

output "server_instance_id" {
  description = "For Session Manager: aws ssm start-session --target <this>"
  value       = aws_instance.server.id
}

output "documents_bucket" {
  value = module.storage.bucket_name
}

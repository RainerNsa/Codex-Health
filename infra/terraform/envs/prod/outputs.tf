# All null while enabled = false.

output "documents_bucket" {
  value = one(module.storage[*].bucket_name)
}

output "audit_anchor_bucket" {
  value = one(module.audit_anchor[*].bucket_name)
}

output "database_endpoint" {
  value = one(module.database[*].endpoint)
}

output "processing_queue_url" {
  value = one(module.queue[*].processing_queue_url)
}

output "cognito_user_pool_id" {
  value = one(module.auth[*].user_pool_id)
}

output "cognito_web_client_id" {
  value = one(module.auth[*].web_client_id)
}

output "egress_allowlist" {
  value = one(module.network[*].endpoint_services)
}

output "documents_bucket" {
  value = module.storage.bucket_name
}

output "audit_anchor_bucket" {
  value = module.audit_anchor.bucket_name
}

output "database_endpoint" {
  value = module.database.endpoint
}

output "processing_queue_url" {
  value = module.queue.processing_queue_url
}

output "cognito_user_pool_id" {
  value = module.auth.user_pool_id
}

output "cognito_web_client_id" {
  value = module.auth.web_client_id
}

output "egress_allowlist" {
  value = module.network.endpoint_services
}

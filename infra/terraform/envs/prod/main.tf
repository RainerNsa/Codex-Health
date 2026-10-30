# prod: GATED. Production is deferred to M7 (dev-alignment 1.12). `enabled`
# defaults to false and every module is count-guarded, so `terraform plan` here
# shows zero resources until a founder flips enabled = true in prod.tfvars at
# M7, after the AWS BAA is accepted and the security lead has signed off
# (README "nothing is applied until").
#
# Real PHI will exist here one day: Multi-AZ, deletion protection, 35-day
# backups, no NAT, no force_destroy.

locals {
  n = var.enabled ? 1 : 0
}

module "kms" {
  source = "../../modules/kms"
  count  = local.n

  environment    = var.environment
  user_role_arns = [for k in ["api", "worker", "worker_session"] : module.compute_roles[0].role_arns[k]]
}

module "network" {
  source = "../../modules/network"
  count  = local.n

  environment             = var.environment
  documents_bucket_arn    = module.storage[0].bucket_arn
  audit_anchor_bucket_arn = module.audit_anchor[0].bucket_arn
  bedrock_model_arns      = var.bedrock_model_arns
}

module "storage" {
  source = "../../modules/storage"
  count  = local.n

  bucket_name         = var.documents_bucket_name
  kms_key_arn         = module.kms[0].key_arn
  retention_days      = var.documents_retention_days
  principal_role_arns = [module.compute_roles[0].role_arns["api"], module.compute_roles[0].role_arns["worker_session"]]
}

module "database" {
  source = "../../modules/database"
  count  = local.n

  environment           = var.environment
  kms_key_arn           = module.kms[0].key_arn
  private_subnet_ids    = module.network[0].private_subnet_ids
  db_security_group_id  = module.network[0].db_security_group_id
  instance_class        = var.db_instance_class
  multi_az              = true
  backup_retention_days = 35
  deletion_protection   = true
}

module "queue" {
  source = "../../modules/queue"
  count  = local.n

  environment        = var.environment
  kms_key_arn        = module.kms[0].key_arn
  sender_role_arns   = [module.compute_roles[0].role_arns["api"]]
  consumer_role_arns = [module.compute_roles[0].role_arns["worker"]]
}

module "auth" {
  source = "../../modules/auth"
  count  = local.n

  environment = var.environment
}

module "budgets" {
  source = "../../modules/budgets"
  count  = local.n

  environment        = var.environment
  monthly_amount_usd = var.monthly_budget_usd
  alert_email        = var.budget_alert_email
}

module "audit_anchor" {
  source = "../../modules/audit-anchor"
  count  = local.n

  providers = { aws.anchor = aws.anchor }

  environment       = var.environment
  bucket_name       = var.audit_anchor_bucket_name
  anchor_account_id = var.audit_anchor_account_id
  writer_role_arn   = module.compute_roles[0].role_arns["anchor_writer"]
  verifier_role_arn = module.compute_roles[0].role_arns["anchor_verifier"]
}

module "logs" {
  source = "../../modules/logs"
  count  = local.n

  environment = var.environment
  kms_key_arn = module.kms[0].key_arn
}

# Roles only; services and task definitions arrive with the M4 thin slice.
module "compute_roles" {
  source = "../../modules/compute-roles"
  count  = local.n

  environment             = var.environment
  documents_bucket_arn    = module.storage[0].bucket_arn
  audit_anchor_bucket_arn = module.audit_anchor[0].bucket_arn
  audit_anchor_key_arn    = module.audit_anchor[0].key_arn
  processing_queue_arn    = module.queue[0].processing_queue_arn
  dlq_arn                 = module.queue[0].dlq_arn
  bedrock_model_arns      = var.bedrock_model_arns
  log_group_arns          = module.logs[0].log_group_arns
}

# Detective control for this account (SPEC §12.2 "account operator" row); the
# organization trail is in envs/org.
resource "aws_guardduty_detector" "this" {
  count = local.n

  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
}

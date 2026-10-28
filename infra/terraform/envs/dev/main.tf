# dev: synthetic data only (dev-alignment 0.11). Cheapest settings, destroyable,
# NAT optional for package pulls. Still private-only with the egress allowlist,
# because the point of dev is to prove the allowlist works before test exists.

data "aws_caller_identity" "current" {}

module "kms" {
  source = "../../modules/kms"

  environment             = var.environment
  deletion_window_in_days = 7
}

module "network" {
  source = "../../modules/network"

  environment             = var.environment
  allow_nat               = var.allow_nat
  documents_bucket_arn    = module.storage.bucket_arn
  audit_anchor_bucket_arn = module.audit_anchor.bucket_arn
  bedrock_model_arns      = var.bedrock_model_arns
}

module "storage" {
  source = "../../modules/storage"

  bucket_name    = var.documents_bucket_name
  kms_key_arn    = module.kms.key_arn
  retention_days = var.documents_retention_days
  force_destroy  = true
}

module "database" {
  source = "../../modules/database"

  environment           = var.environment
  kms_key_arn           = module.kms.key_arn
  private_subnet_ids    = module.network.private_subnet_ids
  db_security_group_id  = module.network.db_security_group_id
  deletion_protection   = false
  backup_retention_days = 1
}

module "queue" {
  source = "../../modules/queue"

  environment = var.environment
  kms_key_arn = module.kms.key_arn
}

module "auth" {
  source = "../../modules/auth"

  environment         = var.environment
  deletion_protection = false
}

module "budgets" {
  source = "../../modules/budgets"

  environment        = var.environment
  monthly_amount_usd = var.monthly_budget_usd
  alert_email        = var.budget_alert_email
}

module "audit_anchor" {
  source = "../../modules/audit-anchor"

  providers = { aws.anchor = aws.anchor }

  environment       = var.environment
  bucket_name       = var.audit_anchor_bucket_name
  anchor_account_id = var.audit_anchor_account_id
  writer_role_arn   = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.audit_anchor_writer_role_name}"
}

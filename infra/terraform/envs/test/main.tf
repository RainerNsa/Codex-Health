# test: synthetic data only (dev-alignment 0.11), but configured like prod so
# the egress, RLS and deletion drills prove something: deletion protection on,
# no NAT, no force_destroy, longer backups. The BAA-covered evaluation
# environment for real de-identified packets is NOT this root; it is a founder
# decision and a separate account (see README open questions).

data "aws_caller_identity" "current" {}

module "kms" {
  source = "../../modules/kms"

  environment = var.environment
}

module "network" {
  source = "../../modules/network"

  environment             = var.environment
  documents_bucket_arn    = module.storage.bucket_arn
  audit_anchor_bucket_arn = module.audit_anchor.bucket_arn
  bedrock_model_arns      = var.bedrock_model_arns
  # allow_nat is not exposed here: test never has general egress.
}

module "storage" {
  source = "../../modules/storage"

  bucket_name    = var.documents_bucket_name
  kms_key_arn    = module.kms.key_arn
  retention_days = var.documents_retention_days
}

module "database" {
  source = "../../modules/database"

  environment          = var.environment
  kms_key_arn          = module.kms.key_arn
  private_subnet_ids   = module.network.private_subnet_ids
  db_security_group_id = module.network.db_security_group_id
  deletion_protection  = true
}

module "queue" {
  source = "../../modules/queue"

  environment = var.environment
  kms_key_arn = module.kms.key_arn
}

module "auth" {
  source = "../../modules/auth"

  environment = var.environment
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

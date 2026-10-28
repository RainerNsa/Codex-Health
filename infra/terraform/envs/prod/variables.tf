variable "enabled" {
  description = "M7 gate (dev-alignment 1.12). false creates nothing. Set true only in prod.tfvars, by a founder, after the README preconditions are met."
  type        = bool
  default     = false
}

variable "region" {
  type    = string
  default = "us-east-1"

  validation {
    condition     = contains(["us-east-1", "us-west-2"], var.region)
    error_message = "Only us-east-1 and us-west-2 are permitted (Bedrock pinned to US regions; the org SCP denies the rest)."
  }
}

variable "environment" {
  type    = string
  default = "prod"

  validation {
    condition     = var.environment == "prod"
    error_message = "This root is the prod environment."
  }
}

variable "documents_bucket_name" {
  description = "e.g. codex-healthd-documents-<ACCOUNT_ID>"
  type        = string
  default     = "codex-healthd-documents-<ACCOUNT_ID>"
}

variable "documents_retention_days" {
  description = "Short purge class. FOUNDER DECISION (dev-alignment §4 q6); the placeholder must be replaced before enabled = true."
  type        = number
  default     = 90
}

variable "db_instance_class" {
  description = "Sized from the M0 cost spike and pilot volume; placeholder."
  type        = string
  default     = "db.t4g.medium"
}

variable "monthly_budget_usd" {
  description = "FINANCE DECISION; placeholder."
  type        = number
  default     = 1000
}

variable "budget_alert_email" {
  type    = string
  default = "finance@example.invalid"
}

variable "audit_anchor_account_id" {
  type    = string
  default = "<ANCHOR_ACCOUNT_ID>"
}

variable "audit_anchor_role_name" {
  type    = string
  default = "CodexHealthAuditAnchorDeployer"
}

variable "audit_anchor_bucket_name" {
  type    = string
  default = "codex-healthd-audit-anchor-<ANCHOR_ACCOUNT_ID>"
}

variable "audit_anchor_writer_role_name" {
  description = "Name of the anchoring task role in THIS account (created with compute at M1); the only principal the anchor bucket lets write."
  type        = string
  default     = "CodexHealthAuditAnchorWriter"
}

variable "bedrock_model_arns" {
  description = "Pinned model / inference-profile ARN(s) the bedrock-runtime endpoint may invoke. Exact version id, never an alias; must match the product's pinned model id (CONSTRAINTS 4.2)."
  type        = list(string)
  default     = ["arn:aws:bedrock:us-east-1::foundation-model/<PINNED_MODEL_ID>"]
}

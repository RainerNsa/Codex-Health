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
  default = "test"

  validation {
    condition     = var.environment == "test"
    error_message = "This root is the test environment."
  }
}

variable "documents_bucket_name" {
  description = "e.g. codex-health-test-documents-<ACCOUNT_ID>"
  type        = string
}

variable "documents_retention_days" {
  description = "Short purge class. The number is a founder decision (dev-alignment §4 q6); 90 is the placeholder."
  type        = number
  default     = 90
}

variable "monthly_budget_usd" {
  description = "Placeholder until the finance lead's budget exists."
  type        = number
  default     = 300
}

variable "budget_alert_email" {
  description = "e.g. finance@example.invalid; set in test.tfvars, never committed."
  type        = string
}

variable "audit_anchor_account_id" {
  description = "<ANCHOR_ACCOUNT_ID>; the separate account that holds the Object Lock bucket."
  type        = string
}

variable "audit_anchor_role_name" {
  type    = string
  default = "CodexHealthAuditAnchorDeployer"
}

variable "audit_anchor_bucket_name" {
  description = "e.g. codex-health-test-audit-anchor-<ANCHOR_ACCOUNT_ID>"
  type        = string
}

variable "audit_anchor_writer_role_name" {
  description = "Name of the anchoring task role in THIS account (created with compute at M1); the only principal the anchor bucket lets write."
  type        = string
  default     = "CodexHealthAuditAnchorWriter"
}

variable "bedrock_model_arns" {
  description = "Pinned model / inference-profile ARN(s) the bedrock-runtime endpoint may invoke. Exact version id, never an alias; must match the product's pinned model id (CONSTRAINTS 4.2)."
  type        = list(string)
}

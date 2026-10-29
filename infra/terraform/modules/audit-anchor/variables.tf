variable "environment" {
  type = string
}

variable "bucket_name" {
  description = "Globally unique, e.g. codex-health-<env>-audit-anchor-<ANCHOR_ACCOUNT_ID>."
  type        = string
}

variable "anchor_account_id" {
  description = "The separate AWS account that owns the anchor bucket and key. Placeholder <ANCHOR_ACCOUNT_ID> until the founders approve the accounts."
  type        = string
}

variable "writer_role_arn" {
  description = "ARN of the anchoring task role in the workload account (modules/compute-roles): the only principal that may PutObject. It must exist before this module is applied (AWS rejects a policy naming a missing principal); passing the module output orders that."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:iam::[^:]+:role/", var.writer_role_arn))
    error_message = "writer_role_arn must be an IAM role ARN, never an account root."
  }
}

variable "verifier_role_arn" {
  description = "ARN of the verifier task role in the workload account (modules/compute-roles): the only principal that may Get and List anchors. Distinct from writer_role_arn by design."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:iam::[^:]+:role/", var.verifier_role_arn))
    error_message = "verifier_role_arn must be an IAM role ARN, never an account root."
  }
}

variable "lock_retention_days" {
  description = "Object Lock COMPLIANCE retention. Default 6 years to match the decision/audit retention class (dev-alignment 1.8)."
  type        = number
  default     = 2190
}

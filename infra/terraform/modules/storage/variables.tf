variable "bucket_name" {
  description = "Globally unique bucket name, e.g. codex-health-<env>-documents-<ACCOUNT_ID>. Supplied per environment; never hardcoded here."
  type        = string
}

variable "kms_key_arn" {
  description = "ARN of the environment CMK (modules/kms)."
  type        = string
}

variable "retention_days" {
  description = "Lifecycle expiry for the short purge class, in days. The number is a founder decision (dev-alignment §4 q6); the engineering default is a placeholder until then."
  type        = number
  default     = 90

  validation {
    condition     = var.retention_days >= 1 && var.retention_days <= 2190
    error_message = "retention_days must be between 1 and 2190 (6 years); documents are never retained longer than decision records."
  }
}

variable "force_destroy" {
  description = "Allow terraform destroy to remove a non-empty bucket. dev only; never test or prod."
  type        = bool
  default     = false
}

variable "principal_role_arns" {
  description = "Role ARNs allowed to read, write and list objects: the API role and the worker session role (modules/compute-roles). Empty (before compute exists) emits no principal deny."
  type        = list(string)
  default     = []
}

variable "upload_origins" {
  description = "Exact origins of the web app (https://...) allowed to PUT uploads to quarantine/ on a signed URL. Empty: no CORS rule."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for o in var.upload_origins : can(regex("^https://[a-z0-9.-]+$", o))])
    error_message = "Each upload origin is an exact https origin, no wildcard, no path."
  }
}

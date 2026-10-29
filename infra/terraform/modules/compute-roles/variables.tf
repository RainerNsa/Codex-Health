variable "environment" {
  type = string
}

variable "documents_bucket_arn" {
  description = "ARN of the documents bucket (modules/storage). Objects live under documents/<facility_id>/..."
  type        = string
}

variable "audit_anchor_bucket_arn" {
  description = "ARN of the Object Lock bucket in the anchor account (modules/audit-anchor)."
  type        = string
}

variable "audit_anchor_key_arn" {
  description = "ARN of the anchor bucket's CMK in the anchor account (modules/audit-anchor)."
  type        = string
}

variable "processing_queue_arn" {
  description = "ARN of the processing queue (modules/queue)."
  type        = string
}

variable "bedrock_model_arns" {
  description = "The pinned foundation-model or inference-profile ARN(s) the worker may invoke; an exact version, never an alias (CONSTRAINTS 4.2)."
  type        = list(string)

  validation {
    condition     = length(var.bedrock_model_arns) >= 1 && alltrue([for a in var.bedrock_model_arns : startswith(a, "arn:aws:bedrock:")])
    error_message = "bedrock_model_arns must hold at least one arn:aws:bedrock:... ARN."
  }
}

variable "log_group_arns" {
  description = "Log group ARN per task (modules/logs): keys api, worker, anchor."
  type        = map(string)

  validation {
    condition     = alltrue([for k in ["api", "worker", "anchor"] : contains(keys(var.log_group_arns), k)])
    error_message = "log_group_arns needs the keys api, worker and anchor."
  }
}

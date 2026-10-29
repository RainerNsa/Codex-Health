variable "environment" {
  type = string
}

variable "kms_key_arn" {
  description = "ARN of the environment CMK (modules/kms); its policy must admit logs.<region>.amazonaws.com."
  type        = string
}

variable "retention_days" {
  description = "Log retention. SPEC §12.1 caps it at 30 days; ids only may be logged, but a short window bounds any leak."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30], var.retention_days)
    error_message = "retention_days must be a CloudWatch value no greater than 30 (SPEC §12.1)."
  }
}

variable "environment" {
  description = "dev, test or prod."
  type        = string
}

variable "deletion_window_in_days" {
  description = "Waiting period before a scheduled key deletion takes effect. 30 (the maximum) outside dev."
  type        = number
  default     = 30
}

variable "user_role_arns" {
  description = "Task role ARNs (modules/compute-roles) granted use-only actions on the key: api, worker and worker-session. Nobody but the account root gets kms:*."
  type        = list(string)
  default     = []
}

variable "environment" {
  description = "dev, test or prod."
  type        = string
}

variable "deletion_window_in_days" {
  description = "Waiting period before a scheduled key deletion takes effect. 30 (the maximum) outside dev."
  type        = number
  default     = 30
}

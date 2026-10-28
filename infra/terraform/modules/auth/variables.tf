variable "environment" {
  type = string
}

variable "deletion_protection" {
  description = "true in test and prod."
  type        = bool
  default     = true
}

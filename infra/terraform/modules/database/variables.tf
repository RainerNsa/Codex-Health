variable "environment" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "private_subnet_ids" {
  description = "At least two private subnets in different AZs (RDS subnet group requirement)."
  type        = list(string)
}

variable "db_security_group_id" {
  description = "Security group that admits 5432 from workers only (modules/network)."
  type        = string
}

variable "instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "allocated_storage_gb" {
  type    = number
  default = 20
}

variable "max_allocated_storage_gb" {
  type    = number
  default = 100
}

variable "multi_az" {
  type    = bool
  default = false
}

variable "backup_retention_days" {
  description = "Automated backup window. Backups hold PHI: the deletion drill (dev-alignment 6.8) must cover them, so keep this bounded."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be 1..35."
  }
}

variable "deletion_protection" {
  description = "true in test and prod. Also controls whether a final snapshot is taken on destroy."
  type        = bool
  default     = true
}

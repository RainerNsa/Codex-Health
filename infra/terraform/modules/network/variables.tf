variable "environment" {
  type = string
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "private_subnet_cidrs" {
  description = "One per AZ; at least two for the RDS subnet group."
  type        = list(string)
  default     = ["10.40.1.0/24", "10.40.2.0/24"]

  validation {
    condition     = length(var.private_subnet_cidrs) >= 2
    error_message = "At least two private subnets are required."
  }
}

variable "allow_nat" {
  description = "Create a NAT gateway and general internet egress. Dev only, off by default; never true in test or prod."
  type        = bool
  default     = false
}

variable "nat_public_subnet_cidr" {
  description = "Used only when allow_nat = true."
  type        = string
  default     = "10.40.255.0/24"
}

variable "documents_bucket_arn" {
  description = "ARN of the documents bucket (modules/storage); the S3 endpoint policy allows no other bucket in this account."
  type        = string
}

variable "audit_anchor_bucket_arn" {
  description = "ARN of the audit-anchor bucket in the separate anchor account (modules/audit-anchor); the only cross-account S3 destination."
  type        = string
}

variable "bedrock_model_arns" {
  description = "The pinned foundation-model or inference-profile ARN(s) the bedrock-runtime endpoint may invoke; an exact version, never an alias (CONSTRAINTS 4.2). A cross-region inference profile needs the profile ARN plus the model ARN in each region it routes to."
  type        = list(string)

  validation {
    condition     = length(var.bedrock_model_arns) >= 1 && alltrue([for a in var.bedrock_model_arns : startswith(a, "arn:aws:bedrock:")])
    error_message = "bedrock_model_arns must hold at least one arn:aws:bedrock:... ARN."
  }
}

variable "region" {
  description = "Region for everything. Bedrock and Textract are both offered in us-east-1."
  type        = string
  default     = "us-east-1"
}

variable "repo_ref" {
  description = "The commit (full 40-character sha) of github.com/RainerNsa/Codex-Health that the server runs. Pinned, so a deploy is reproducible."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.repo_ref))
    error_message = "repo_ref is a full 40-character commit sha."
  }
}

variable "gate_username" {
  description = "User name for the password gate in front of the whole demo."
  type        = string
  default     = "codex"
}

variable "gate_password" {
  description = "Password for the gate (at least 16 characters). Share it only with people who should see the demo."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.gate_password) >= 16 && !can(regex(":", var.gate_password))
    error_message = "The gate password needs at least 16 characters and no colon."
  }
}

variable "budget_alert_email" {
  description = "Where AWS Budgets sends cost alerts."
  type        = string
}

variable "monthly_budget_usd" {
  description = "Monthly budget that triggers the alerts (the demo is designed to stay well under it)."
  type        = number
  default     = 40
}

variable "instance_type" {
  description = "The one server (ARM). t4g.small: 2 vCPU, 2 GiB, enough for Postgres, the API and the build."
  type        = string
  default     = "t4g.small"
}

variable "node_version" {
  description = "Node.js 24 release the server installs from nodejs.org, checked against its published SHA-256."
  type        = string
  default     = "24.11.0"
}

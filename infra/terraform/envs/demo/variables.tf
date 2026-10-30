variable "region" {
  description = "Region for everything: us-east-1, where CloudFront's certificate must live and Bedrock and Textract are offered."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.region == "us-east-1"
    error_message = "The demo runs in us-east-1 (CloudFront certificates must be issued there)."
  }
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

variable "domain_name" {
  description = "Your domain, registered in (or delegated to) Route 53 in this account, e.g. example.com. The demo is served at demo_subdomain.domain_name with TLS 1.2 or newer only."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+(\\.[a-z0-9-]+)+$", var.domain_name))
    error_message = "domain_name is a bare domain like example.com (lower case, no https://, no trailing dot)."
  }
}

variable "demo_subdomain" {
  description = "The demo's host name under domain_name."
  type        = string
  default     = "demo"
}

variable "bedrock_model_id" {
  description = "The pinned Bedrock model id the worker calls, with a date and version: anthropic.claude-<name>-<YYYYMMDD>-v<n>:<m>. Model access must be enabled for it in the region."
  type        = string

  validation {
    condition     = can(regex("^anthropic\\.claude-[a-z0-9-]+-[0-9]{8}-v[0-9]+:[0-9]+$", var.bedrock_model_id))
    error_message = "bedrock_model_id must be a pinned id with a date and version, never an alias."
  }
}

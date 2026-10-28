provider "aws" {
  region = var.region

  # Every resource carries environment and project (dev-alignment 1.11).
  # Facility is NOT a tag: resources are shared across facilities and data is
  # tenant-scoped by RLS and S3 prefixes, not by resource.
  default_tags {
    tags = {
      project     = "codex-health"
      environment = var.environment
      managed_by  = "terraform"
    }
  }
}

# The audit-anchor account. Assumes a deployer role there; the account id is a
# variable so no account id is ever committed.
provider "aws" {
  alias  = "anchor"
  region = var.region

  assume_role {
    role_arn = "arn:aws:iam::${var.audit_anchor_account_id}:role/${var.audit_anchor_role_name}"
  }

  default_tags {
    tags = {
      project     = "codex-health"
      environment = var.environment
      managed_by  = "terraform"
    }
  }
}

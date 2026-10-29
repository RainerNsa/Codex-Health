variable "trail_bucket_name" {
  description = "Globally unique, e.g. codex-health-org-cloudtrail-<MANAGEMENT_ACCOUNT_ID>. Supplied in org.tfvars; never hardcoded."
  type        = string
}

variable "guardduty_admin_account_id" {
  description = "The account designated GuardDuty delegated administrator for the organization; placeholder <ANCHOR_ACCOUNT_ID> until the founders approve the accounts. Must not be the management account."
  type        = string
}

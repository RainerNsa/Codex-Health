variable "target_ids" {
  description = "The workloads OU id (ou-xxxx-xxxxxxxx) holding dev, test and prod. Never the organization root."
  type        = list(string)
}

variable "trail_bucket_name" {
  description = "e.g. codex-health-org-cloudtrail-<MANAGEMENT_ACCOUNT_ID>; the organization trail's bucket, in the management account."
  type        = string
}

variable "guardduty_admin_account_id" {
  description = "<ANCHOR_ACCOUNT_ID>: the GuardDuty delegated administrator for the organization. Never the management account."
  type        = string
}

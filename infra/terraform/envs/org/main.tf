# Organization root: run from the management account, once, against the OU
# that holds the dev/test/prod workload accounts. Separate from the env roots
# because SCPs and opt-out policies can only be created in the management
# account, which must itself hold nothing but Organizations and billing.

provider "aws" {
  region = "us-east-1" # Organizations is a global service; the region only picks the endpoint.

  default_tags {
    tags = {
      project    = "codex-health"
      managed_by = "terraform"
    }
  }
}

module "org_guardrails" {
  source = "../../modules/org-guardrails"

  target_ids = var.target_ids
}

# Organization CloudTrail trail and the GuardDuty delegated-admin designation
# (SPEC §12.2 "account operator" row). Member-account detectors live in each
# workload root.
module "detective" {
  source = "../../modules/detective"

  trail_bucket_name          = var.trail_bucket_name
  guardduty_admin_account_id = var.guardduty_admin_account_id
}

output "policy_ids" {
  value = module.org_guardrails.policy_ids
}

output "cloudtrail_trail_arn" {
  value = module.detective.trail_arn
}

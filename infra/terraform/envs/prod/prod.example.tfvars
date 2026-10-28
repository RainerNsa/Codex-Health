# Copy to prod.tfvars (gitignored) at M7. Leave enabled = false until the
# README preconditions are met and a founder has approved production.
enabled                  = false
region                   = "us-east-1"
documents_bucket_name    = "codex-healthd-documents-<ACCOUNT_ID>"
documents_retention_days = 90
db_instance_class        = "db.t4g.medium"
monthly_budget_usd       = 1000
budget_alert_email       = "finance@example.invalid"
audit_anchor_account_id  = "<ANCHOR_ACCOUNT_ID>"
audit_anchor_bucket_name = "codex-healthd-audit-anchor-<ANCHOR_ACCOUNT_ID>"
bedrock_model_arns       = ["arn:aws:bedrock:us-east-1::foundation-model/<PINNED_MODEL_ID>"]

# Copy to test.tfvars (gitignored) and fill in. Placeholders only in this file.
region                   = "us-east-1"
documents_bucket_name    = "codex-health-test-documents-<ACCOUNT_ID>"
documents_retention_days = 90
monthly_budget_usd       = 300
budget_alert_email       = "finance@example.invalid"
audit_anchor_account_id  = "<ANCHOR_ACCOUNT_ID>"
audit_anchor_bucket_name = "codex-health-test-audit-anchor-<ANCHOR_ACCOUNT_ID>"
bedrock_model_arns       = ["arn:aws:bedrock:us-east-1::foundation-model/<PINNED_MODEL_ID>"]

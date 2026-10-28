# One customer-managed key per environment (dev-alignment 1.11; security.md §4
# "KMS on every bucket"). S3, RDS, SQS and the RDS-managed master password all
# use this key. The default key policy (account root) is kept on purpose: which
# roles may use the key is decided by IAM policies that arrive with compute.

resource "aws_kms_key" "this" {
  description             = "Codex Health ${var.environment} data key"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = var.deletion_window_in_days
  multi_region            = false
}

resource "aws_kms_alias" "this" {
  name          = "alias/codex-health-${var.environment}"
  target_key_id = aws_kms_key.this.key_id
}

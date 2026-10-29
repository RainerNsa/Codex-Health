# CloudWatch log groups for the api, worker and anchor tasks (SPEC §12.1: "to be
# created with KMS and <= 30-day retention at M1; nothing but ids may land
# there"; data policy 5: logs carry a field allowlist of ids, never values).
# Encrypted with the environment CMK, whose policy admits the regional logs
# service principal (modules/kms). Task roles may only CreateLogStream and
# PutLogEvents on their own group (modules/compute-roles).

resource "aws_cloudwatch_log_group" "this" {
  for_each = toset(["api", "worker", "anchor"])

  name              = "/codex-health/${var.environment}/${each.key}"
  retention_in_days = var.retention_days
  kms_key_id        = var.kms_key_arn
}

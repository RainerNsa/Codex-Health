# RDS Postgres 16 for tenant data, decisions and the audit log (dev-alignment
# 1.9, 1.10; security.md §4). Encrypted with the environment CMK, private
# subnets only, never publicly accessible, TLS forced.
#
# No PHI in logs: the parameter group sets log_statement = none and disables
# duration logging, so query text (which carries fact values) never reaches
# CloudWatch. Error paths are closed too: a failing statement is not echoed
# (log_min_error_statement = panic), bind parameters are never logged on error
# (log_parameter_max_length_on_error = 0), and messages drop DETAIL/HINT/CONTEXT
# (log_error_verbosity = terse), which otherwise quote the offending row.
# No CloudWatch log exports are enabled for the same reason.
# Performance Insights is off until the security lead approves it: it stores
# SQL text, which is PHI here.
#
# RLS itself (FORCE ROW LEVEL SECURITY, non-BYPASSRLS app role, SET LOCAL
# facility_id) is schema, not infrastructure: packages/db owns it.

resource "aws_db_subnet_group" "this" {
  name       = "codex-health-${var.environment}"
  subnet_ids = var.private_subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name   = "codex-health-${var.environment}-postgres16"
  family = "postgres16"

  parameter {
    name  = "log_statement"
    value = "none"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "-1"
  }

  parameter {
    name  = "log_min_error_statement"
    value = "panic"
  }

  parameter {
    name  = "log_error_verbosity"
    value = "terse"
  }

  parameter {
    name  = "log_parameter_max_length_on_error"
    value = "0"
  }

  parameter {
    name  = "log_min_messages"
    value = "warning"
  }

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "this" {
  identifier = "codex-health-${var.environment}"

  engine                     = "postgres"
  engine_version             = "16"
  auto_minor_version_upgrade = true
  instance_class             = var.instance_class
  allocated_storage          = var.allocated_storage_gb
  max_allocated_storage      = var.max_allocated_storage_gb
  storage_type               = "gp3"
  storage_encrypted          = true
  kms_key_id                 = var.kms_key_arn

  db_name                       = "codex_health"
  username                      = "codex_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn
  ca_cert_identifier            = "rds-ca-rsa2048-g1"

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.db_security_group_id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false
  multi_az               = var.multi_az

  backup_retention_period   = var.backup_retention_days
  copy_tags_to_snapshot     = true
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = !var.deletion_protection
  final_snapshot_identifier = var.deletion_protection ? "codex-health-${var.environment}-final" : null

  performance_insights_enabled    = false
  enabled_cloudwatch_logs_exports = []
  apply_immediately               = false

  lifecycle {
    # RDS moves minor versions on its own; do not fight it in plan output.
    ignore_changes = [engine_version]
  }
}

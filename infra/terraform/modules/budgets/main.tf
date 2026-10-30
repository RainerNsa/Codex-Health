# AWS Budgets alarm per environment account (dev-alignment 1.11; finance review:
# "no budget, no cost per referral"). Account-wide cost, monthly, alerts at 80% and
# 100% of actual spend and at 100% forecast. Per-referral cost comes from metering in
# the data model (1.6), not from here.

resource "aws_budgets_budget" "monthly" {
  name         = "codex-health-${var.environment}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_amount_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Credits count as payment by default, so an account living on credits shows about $0 and the alerts never fire;
  # include_credits = false measures usage before credits (the demo's case).
  cost_types {
    include_credit = var.include_credits
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

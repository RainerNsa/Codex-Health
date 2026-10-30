variable "environment" {
  type = string
}

variable "monthly_amount_usd" {
  description = "Monthly cost ceiling for this account. The number is the finance lead's (one-page budget, COO brief decision 2); the default is a placeholder."
  type        = number
}

variable "alert_email" {
  description = "Where budget alerts go. A founder or finance mailbox, never a personal address committed to git."
  type        = string
}

variable "include_credits" {
  description = "Whether credits reduce the measured cost. false for an account running on credits, so the alerts track real usage."
  type        = bool
  default     = true
}

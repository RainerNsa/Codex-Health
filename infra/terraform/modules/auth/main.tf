# Cognito user pool: MFA required for every role (decision log 2026-10-21), TOTP
# only (no SMS: a phone number is a lesser factor and an SMS line item), strong
# password policy, advanced security in AUDIT mode, no self sign-up (orgs and
# first Admins are provisioned through the audited internal path, dev-alignment 1.13).
#
# NO PATIENT DATA IN ANY MESSAGE. Cognito email templates below carry only the
# username placeholder and the one-time code. Cognito's default email sender is not
# an entity that may see PHI, and the compliance review (gap 3c) lists Cognito
# email/SMS as a place non-eligible data creeps in. Any future notification about a
# referral goes through an in-app screen, never through Cognito or email.

resource "aws_cognito_user_pool" "this" {
  name                = "codex-health-${var.environment}"
  deletion_protection = var.deletion_protection ? "ACTIVE" : "INACTIVE"

  # Advanced security (AUDIT mode: risk logging, no automatic blocking yet) needs
  # the Plus feature plan. The per-MAU cost is a finance-lead item; see README.
  user_pool_tier = "PLUS"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "ON"

  software_token_mfa_configuration {
    enabled = true
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  user_pool_add_ons {
    advanced_security_mode = "AUDIT"
  }

  admin_create_user_config {
    allow_admin_create_user_only = true

    invite_message_template {
      email_subject = "Your Codex Health account"
      email_message = "Your Codex Health username is {username} and your temporary password is {####}. You will set a new password and an authenticator app at first sign-in."
    }
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Codex Health verification code"
    email_message        = "Your Codex Health verification code is {####}."
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }
}

# One client for the reviewer web app. SRP only (no password over the wire),
# short tokens. The 15-minute access token pairs with the 15-minute idle timeout
# the security review asks for on shared SNF workstations (security.md §2), but
# it is NOT that timeout: a refresh token keeps an idle tab signed in for 8
# hours. The idle timeout is enforced by the web client at M3 (CONSTRAINTS 4.2),
# which signs out and revokes the refresh token after 15 minutes without input.
resource "aws_cognito_user_pool_client" "web" {
  name         = "codex-health-${var.environment}-web"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret               = false
  explicit_auth_flows           = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  access_token_validity  = 15
  id_token_validity      = 15
  refresh_token_validity = 8

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }
}

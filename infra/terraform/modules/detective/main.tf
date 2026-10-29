# Detective controls for the organization (SPEC §12.2 "account operator" and
# "cloud and infrastructure" rows: "break-glass by assumed role with a CloudTrail
# alert (M1 infra, with the organisation trail and GuardDuty)"; README
# "Deliberately missing: CloudTrail organization trail, GuardDuty"). Applied from
# the management account only, like modules/org-guardrails.
#
# CloudTrail: one organization trail, all regions, log file validation on, so a
# workload-account operator cannot stop or edit their own account's audit (the
# SCP also denies StopLogging/DeleteTrail). Management events only: no S3 or
# Lambda data events, since object keys and request parameters are not needed
# for the §12 alerts and ids are all that may land in any log. The trail bucket
# lives in this account with block-public-access, its own CMK, TLS-only and a
# 400-day expiry (one year of history plus a margin, ahead of the M8 restore
# drill). The alerts themselves (GetSecretValue on the master secret,
# AdminCreateUser outside provisioning) are metric filters that arrive with the
# compute roots' log groups; the trail is what they read.
#
# GuardDuty: this account enables a detector and designates the delegated
# administrator account (guardduty_admin_account_id; the audit-anchor account is
# the natural choice). Member auto-enrolment
# (aws_guardduty_organization_configuration) is configured IN the delegated
# admin account, so it arrives when that account gets a Terraform root; until
# then each workload root runs its own detector (envs/dev, test, prod).

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_organizations_organization" "current" {}

locals {
  trail_name = "codex-health-org"
  # Built, not read from the resource, because the bucket and key policies must
  # name the trail before the trail exists.
  trail_arn = "arn:aws:cloudtrail:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:trail/${local.trail_name}"
}

# --- CloudTrail key -------------------------------------------------------------

data "aws_iam_policy_document" "trail_key" {
  statement {
    sid       = "AccountRootAdministersKey"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid       = "CloudTrailEncryptsLogs"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }

    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:cloudtrail:arn"
      values   = ["arn:aws:cloudtrail:*:${data.aws_caller_identity.current.account_id}:trail/*"]
    }
  }
}

resource "aws_kms_key" "trail" {
  description             = "Codex Health organization CloudTrail key"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.trail_key.json
}

resource "aws_kms_alias" "trail" {
  name          = "alias/codex-health-org-cloudtrail"
  target_key_id = aws_kms_key.trail.key_id
}

# --- CloudTrail bucket ----------------------------------------------------------

resource "aws_s3_bucket" "trail" {
  bucket = var.trail_bucket_name
}

resource "aws_s3_bucket_public_access_block" "trail" {
  bucket                  = aws_s3_bucket.trail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "trail" {
  bucket = aws_s3_bucket.trail.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "trail" {
  bucket = aws_s3_bucket.trail.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.trail.arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "trail" {
  bucket = aws_s3_bucket.trail.id

  rule {
    id     = "expire-after-400-days"
    status = "Enabled"

    filter {}

    expiration {
      days = 400
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "trail_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.trail.arn,
      "${aws_s3_bucket.trail.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "CloudTrailChecksBucket"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.trail.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }

  # An organization trail writes under the org id for member accounts and under
  # this account's id for its own events.
  statement {
    sid     = "CloudTrailWritesLogs"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.trail.arn}/AWSLogs/${data.aws_organizations_organization.current.id}/*",
      "${aws_s3_bucket.trail.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*",
    ]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
}

resource "aws_s3_bucket_policy" "trail" {
  bucket = aws_s3_bucket.trail.id
  policy = data.aws_iam_policy_document.trail_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.trail]
}

# --- The trail ------------------------------------------------------------------

resource "aws_cloudtrail" "org" {
  name                          = local.trail_name
  s3_bucket_name                = aws_s3_bucket.trail.id
  kms_key_id                    = aws_kms_key.trail.arn
  is_organization_trail         = true
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true

  # Management events only: nothing here selects S3 or Lambda data events.
  event_selector {
    read_write_type           = "All"
    include_management_events = true
  }

  depends_on = [aws_s3_bucket_policy.trail]
}

# --- GuardDuty ------------------------------------------------------------------

resource "aws_guardduty_detector" "management" {
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
}

resource "aws_guardduty_organization_admin_account" "this" {
  admin_account_id = var.guardduty_admin_account_id

  depends_on = [aws_guardduty_detector.management]
}

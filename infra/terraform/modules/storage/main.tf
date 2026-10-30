# Documents bucket: referral packets, page images, OCR text (dev-alignment 1.8:
# the "short purge class"). Everything in this bucket is PHI once real packets
# exist, so: block public access, KMS, versioning, TLS only, and a lifecycle
# backstop that expires every object (and every non-current version) after
# retention_days. Explicit per-referral deletion (deletion_requests, 1.8) runs
# before that; the lifecycle rule is the floor, not the mechanism.
#
# Tenancy: one shared bucket; objects live under a facility prefix
# (documents/<facility_id>/<referral_id>/...) and are reached only through signed URLs
# issued after an authz check, TTL <= 5 min (security.md §3 risk 1). Facility
# tagging per object is not done: data is tenant-scoped by prefix and RLS,
# not by resource.
#
# Decision and audit records (the 6-year class) do NOT live here; they are in
# Postgres and the audit-anchor bucket.
#
# Principals (SPEC §12.2 "account operator" row, M1): only the roles in
# principal_role_arns (the API role and the per-job worker session role) and the
# account root may touch objects or list the bucket; an admin IAM user reading a
# document is denied unless they first edit this policy, which CloudTrail
# records. The deny covers object actions and listing, not bucket configuration,
# so the deploying identity keeps running plan and apply without being a data
# principal. It is emitted only when the list is non-empty: an ArnNotEquals with
# no values is an invalid policy, and an unconditional deny would lock the
# bucket before compute exists.

resource "aws_s3_bucket" "documents" {
  bucket        = var.bucket_name
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  depends_on = [aws_s3_bucket_versioning.documents]

  rule {
    id     = "purge-short-class"
    status = "Enabled"

    filter {}

    expiration {
      days = var.retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # Uploads wait in quarantine/ only until the API checks and promotes them (or rejects them); anything left there
  # (abandoned, rejected, re-PUT after promotion) expires within a day, every version of it.
  rule {
    id     = "expire-quarantine"
    status = "Enabled"

    filter {
      prefix = "quarantine/"
    }

    expiration {
      days = 1
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }
}

# The browser PUTs uploads straight to quarantine/ on a signed URL: only the app's own origins, PUT only, and no
# extra request headers, so a browser cannot set object metadata. Empty until the app has a domain.
resource "aws_s3_bucket_cors_configuration" "documents" {
  count  = length(var.upload_origins) > 0 ? 1 : 0
  bucket = aws_s3_bucket.documents.id

  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = var.upload_origins
    max_age_seconds = 300
  }
}

data "aws_caller_identity" "current" {}

locals {
  data_principals = concat(var.principal_role_arns, ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"])
}

data "aws_iam_policy_document" "documents" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.documents.arn,
      "${aws_s3_bucket.documents.arn}/*",
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
    sid       = "DenyUnencryptedObjectUploads"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.documents.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  dynamic "statement" {
    for_each = length(var.principal_role_arns) > 0 ? [1] : []
    content {
      sid     = "DenyDataAccessExceptListedRoles"
      effect  = "Deny"
      actions = ["s3:*"]
      resources = [
        "${aws_s3_bucket.documents.arn}/*",
      ]

      principals {
        type        = "*"
        identifiers = ["*"]
      }

      condition {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = local.data_principals
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.principal_role_arns) > 0 ? [1] : []
    content {
      sid       = "DenyListExceptListedRoles"
      effect    = "Deny"
      actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
      resources = [aws_s3_bucket.documents.arn]

      principals {
        type        = "*"
        identifiers = ["*"]
      }

      condition {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = local.data_principals
      }
    }
  }
}

resource "aws_s3_bucket_policy" "documents" {
  bucket = aws_s3_bucket.documents.id
  policy = data.aws_iam_policy_document.documents.json

  depends_on = [aws_s3_bucket_public_access_block.documents]
}

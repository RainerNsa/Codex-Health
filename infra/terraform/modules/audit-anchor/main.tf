# Audit-anchor bucket (dev-alignment 1.10; security.md §2 "the hash chain proves
# less than it sounds"). The daily anchoring job writes each facility chain's root
# hash here. Object Lock in COMPLIANCE mode means nobody, including the account
# root, can delete or overwrite an anchor before its retention expires, so a
# rewritten audit table no longer matches an anchor someone cannot touch.
#
# The bucket lives in a SEPARATE AWS account (the "audit-anchor" account) so that a
# compromise of the workload account does not reach it. Everything here is created
# through the aws.anchor provider alias, which the environment root configures to
# assume a role in that account (variable-named; never hardcoded).
#
# Contents are hashes and ids only, never PHI, but the bucket still gets KMS and
# block-public-access because CONSTRAINTS requires them on every bucket.
#
# Key scheme: <facility_id>/<date>.json and organization/<organization_id>/<date>.json, one anchor per chain per day. Keys
# are write-once: the bucket policy denies PutObject without
# `If-None-Match: *`, so a second write to an existing key fails with 412
# instead of adding a version, and it denies every delete for everyone. The
# verifier reads the FIRST version per key (oldest in the version list); any
# later version, should one ever appear, is itself evidence of tampering.

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = ">= 5.60, < 6.0"
      configuration_aliases = [aws.anchor]
    }
  }
}

resource "aws_kms_key" "anchor" {
  provider = aws.anchor

  description             = "Codex Health ${var.environment} audit-anchor key"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "anchor" {
  provider = aws.anchor

  name          = "alias/codex-health-${var.environment}-audit-anchor"
  target_key_id = aws_kms_key.anchor.key_id
}

resource "aws_s3_bucket" "anchor" {
  provider = aws.anchor

  bucket              = var.bucket_name
  object_lock_enabled = true
}

resource "aws_s3_bucket_public_access_block" "anchor" {
  provider = aws.anchor

  bucket                  = aws_s3_bucket.anchor.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "anchor" {
  provider = aws.anchor

  bucket = aws_s3_bucket.anchor.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "anchor" {
  provider = aws.anchor

  bucket = aws_s3_bucket.anchor.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "anchor" {
  provider = aws.anchor

  bucket = aws_s3_bucket.anchor.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.anchor.arn
    }
  }
}

resource "aws_s3_bucket_object_lock_configuration" "anchor" {
  provider = aws.anchor

  bucket = aws_s3_bucket.anchor.id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.lock_retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.anchor]
}

# Only the anchoring task role (not the whole workload account) may write
# anchors and read them back for verification. Nobody may delete; Object Lock
# would refuse anyway, the explicit Deny makes the plan say so.
data "aws_iam_policy_document" "anchor" {
  provider = aws.anchor

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.anchor.arn,
      "${aws_s3_bucket.anchor.arn}/*",
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
    sid       = "DenyOverwriteWriteOnceKeys"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.anchor.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }

  statement {
    sid       = "DenyDeleteForEveryone"
    effect    = "Deny"
    actions   = ["s3:DeleteObject*"]
    resources = ["${aws_s3_bucket.anchor.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }

  statement {
    sid    = "AnchoringRoleWritesAndReadsAnchors"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:ListBucketVersions",
    ]
    resources = [
      aws_s3_bucket.anchor.arn,
      "${aws_s3_bucket.anchor.arn}/*",
    ]

    principals {
      type        = "AWS"
      identifiers = [var.writer_role_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "anchor" {
  provider = aws.anchor

  bucket = aws_s3_bucket.anchor.id
  policy = data.aws_iam_policy_document.anchor.json

  depends_on = [aws_s3_bucket_public_access_block.anchor]
}

# The key policy must also admit the writer role, or PutObject fails on encrypt.
data "aws_iam_policy_document" "anchor_key" {
  provider = aws.anchor

  statement {
    sid       = "AnchorAccountAdministersKey"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.anchor_account_id}:root"]
    }
  }

  statement {
    sid    = "AnchoringRoleUsesKey"
    effect = "Allow"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = [var.writer_role_arn]
    }
  }
}

resource "aws_kms_key_policy" "anchor" {
  provider = aws.anchor

  key_id = aws_kms_key.anchor.id
  policy = data.aws_iam_policy_document.anchor_key.json
}

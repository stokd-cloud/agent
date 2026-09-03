# ── Retained custody ──────────────────────────────────────────────────────────
# Every resource in this file holds customer state. `prevent_destroy` is the
# Terraform expression of the retained-custody contract: a stage teardown that
# would delete data fails the plan instead of running. Removing the flag is an
# explicit, reviewable act — which is exactly the "refuses unacknowledged
# persistent-data deletion" behavior VAL-OPS-001 asserts.

data "aws_iam_policy_document" "data_key" {
  # KMS refuses any key policy that could lock out future policy updates, so
  # the account must retain administrative access. Access control is delegated
  # to IAM from there, where the workload and deploy boundaries apply.
  statement {
    sid       = "EnableIAMUserPermissions"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid       = "BoundedDeployAdministration"
    effect    = "Allow"
    resources = ["*"]

    actions = [
      "kms:CreateAlias", "kms:DescribeKey", "kms:EnableKeyRotation",
      "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListResourceTags",
      "kms:PutKeyPolicy", "kms:TagResource", "kms:UntagResource", "kms:UpdateAlias",
    ]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalArn"
      values   = [local.deploy_role_arn]
    }
  }

  statement {
    sid       = "BoundedDeployServiceUse"
    effect    = "Allow"
    resources = ["*"]

    actions = [
      "kms:Decrypt", "kms:DescribeKey", "kms:Encrypt",
      "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext", "kms:ReEncrypt*",
    ]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalArn"
      values   = [local.deploy_role_arn]
    }

    condition {
      test     = "StringLike"
      variable = "kms:ViaService"
      values = [
        "ec2.${local.region}.amazonaws.com",
        "secretsmanager.${local.region}.amazonaws.com",
      ]
    }
  }

  # Evidence written by the deploy role is scoped to this item's exact prefix so
  # a validation run cannot encrypt or read unrelated objects.
  statement {
    sid       = "BoundedDeployEvidenceS3Use"
    effect    = "Allow"
    resources = ["*"]

    actions = [
      "kms:Decrypt", "kms:DescribeKey", "kms:Encrypt",
      "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext", "kms:ReEncrypt*",
    ]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalArn"
      values   = [local.deploy_role_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = ["arn:aws:s3:::${local.artifact_bucket_name}/validation/work-1.2/${var.stage}/*"]
    }
  }

  statement {
    sid       = "BoundedDeployServiceGrant"
    effect    = "Allow"
    resources = ["*"]
    actions   = ["kms:CreateGrant"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalArn"
      values   = [local.deploy_role_arn]
    }

    condition {
      test     = "Bool"
      variable = "kms:GrantIsForAWSResource"
      values   = ["true"]
    }
  }

  # The restore stage's Mongo role is named explicitly so a restore can read
  # source-stage material without widening the source stage's own key policy.
  statement {
    sid       = "ExactAgentWorkloads"
    effect    = "Allow"
    resources = ["*"]

    actions = [
      "kms:Decrypt", "kms:DescribeKey", "kms:Encrypt",
      "kms:GenerateDataKey", "kms:ReEncrypt*",
    ]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringLike"
      variable = "aws:PrincipalArn"
      values = [
        "arn:aws:iam::${local.account_id}:role/${local.mongo_role_name}",
        "arn:aws:iam::${local.account_id}:role/stokd-agent-workload-mongo-restore-val12",
        "arn:aws:iam::${local.account_id}:role/stokd-agent-workload-api-${var.stage}-*",
      ]
    }
  }
}

resource "aws_kms_key" "data" {
  description             = "Retained Agent ${var.stage} data custody"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.data_key.json

  tags = local.persistent_tags

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [aws_iam_role.mongo]
}

resource "aws_kms_alias" "data" {
  name          = "alias/stokd-agent-${var.stage}"
  target_key_id = aws_kms_key.data.key_id

  lifecycle {
    prevent_destroy = true
  }
}

# ── Retained buckets ──────────────────────────────────────────────────────────

locals {
  buckets = {
    artifacts = local.artifact_bucket_name
    backups   = local.backup_bucket_name
  }
}

resource "aws_s3_bucket" "custody" {
  for_each = local.buckets

  bucket        = each.value
  force_destroy = false
  tags          = local.persistent_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "custody" {
  for_each = aws_s3_bucket.custody

  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# BucketOwnerEnforced disables ACLs outright, which is what makes bucket-owner
# custody provable rather than merely conventional.
resource "aws_s3_bucket_ownership_controls" "custody" {
  for_each = aws_s3_bucket.custody

  bucket = each.value.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "custody" {
  for_each = aws_s3_bucket.custody

  bucket = each.value.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "custody" {
  for_each = aws_s3_bucket.custody

  bucket = each.value.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }

    bucket_key_enabled = true
  }
}

# Backups expire at 30 days; artifacts are kept indefinitely as current
# versions. Both retain noncurrent versions for 30 days, which is the window a
# restore is allowed to reach back through.
resource "aws_s3_bucket_lifecycle_configuration" "custody" {
  for_each = aws_s3_bucket.custody

  bucket = each.value.id

  rule {
    id     = "thirty-day-version-custody"
    status = "Enabled"

    filter {}

    dynamic "expiration" {
      for_each = each.key == "backups" ? [1] : []

      content {
        days = 30
      }
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.custody]
}

data "aws_iam_policy_document" "custody_bucket" {
  for_each = aws_s3_bucket.custody

  statement {
    sid       = "DenyNonTls"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [each.value.arn, "${each.value.arn}/*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyUnencryptedWrites"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${each.value.arn}/*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid       = "DenyWrongKey"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${each.value.arn}/*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.data.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "custody" {
  for_each = aws_s3_bucket.custody

  bucket = each.value.id
  policy = data.aws_iam_policy_document.custody_bucket[each.key].json

  depends_on = [aws_s3_bucket_public_access_block.custody]
}

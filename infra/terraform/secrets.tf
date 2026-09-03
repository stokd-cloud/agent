# ── Generated service credentials ─────────────────────────────────────────────
# Secrets Manager generates the credential server-side so the plaintext never
# reaches the deployer, but that generator is only reachable through
# CloudFormation's GenerateSecretString — the AWS Terraform provider exposes no
# equivalent on `aws_secretsmanager_secret`.
#
# So Terraform manages the same template the SST layout already used, through
# aws_cloudformation_stack. Generation semantics are unchanged, the values are
# still created inside AWS, and nothing sensitive enters Terraform state: only
# the three ARNs come back as stack outputs.
#
# Retain policies mean tearing the stack down leaves the credentials in place.
# Deleting one would orphan the data it encrypts.
#
# (On Terraform >= 1.11 this could move to a native resource using a write-only
# `secret_string_wo` fed by an `ephemeral` generator. Homebrew pins terraform at
# 1.5.7 — the last MPL release — so that path is not available here.)

locals {
  secret_kinds = ["runtime", "migration", "backup"]

  secret_template = {
    AWSTemplateFormatVersion = "2010-09-09"

    Resources = {
      for kind in local.secret_kinds :
      "${title(kind)}Secret" => {
        Type                = "AWS::SecretsManager::Secret"
        DeletionPolicy      = "Retain"
        UpdateReplacePolicy = "Retain"

        Properties = {
          Name     = "stokd-agent-${var.stage}-${kind}"
          KmsKeyId = aws_kms_key.data.arn

          GenerateSecretString = {
            PasswordLength     = 48
            ExcludePunctuation = true
          }

          Tags = [
            { Key = "Project", Value = "stokd-agent" },
            { Key = "Stage", Value = var.stage },
            { Key = "Custody", Value = "persistent" },
            { Key = "ManagedBy", Value = "terraform" },
          ]
        }
      }
    }

    Outputs = {
      RuntimeSecretArn   = { Value = { Ref = "RuntimeSecret" } }
      MigrationSecretArn = { Value = { Ref = "MigrationSecret" } }
      BackupSecretArn    = { Value = { Ref = "BackupSecret" } }
    }
  }
}

resource "aws_cloudformation_stack" "credentials" {
  name          = "stokd-agent-${var.stage}-credentials"
  capabilities  = ["CAPABILITY_NAMED_IAM"]
  template_body = jsonencode(local.secret_template)
  tags          = local.persistent_tags

  lifecycle {
    prevent_destroy = true
  }
}

# The restore stage reads the source stage's retained credentials to open the
# backup it is restoring. Read-only, and only in that direction.
#
# These are referenced by ARN pattern rather than looked up, deliberately.
# Secrets Manager appends a random six-character suffix, so the exact ARN is not
# constructible -- but a data lookup would make the restore stage unplannable
# until the source stage is applied, coupling two stages that are meant to be
# independent. The `-*` suffix matches only that one secret's own versions.
locals {
  source_secret_arns = [
    for kind in local.secret_kinds :
    "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:stokd-agent-${local.source_stage}-${kind}-*"
  ]

  runtime_secret_arn   = aws_cloudformation_stack.credentials.outputs["RuntimeSecretArn"]
  migration_secret_arn = aws_cloudformation_stack.credentials.outputs["MigrationSecretArn"]
  backup_secret_arn    = aws_cloudformation_stack.credentials.outputs["BackupSecretArn"]

  source_runtime_secret_arn   = local.is_restore ? "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:stokd-agent-${local.source_stage}-runtime-*" : local.runtime_secret_arn
  source_migration_secret_arn = local.is_restore ? "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:stokd-agent-${local.source_stage}-migration-*" : local.migration_secret_arn
  source_backup_secret_arn    = local.is_restore ? "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:stokd-agent-${local.source_stage}-backup-*" : local.backup_secret_arn
}

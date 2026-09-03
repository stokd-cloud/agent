# Stage identity. Mirrors infra/shared/constants.ts exactly; the structure
# verifier compares the two so they cannot drift.
locals {
  account_id       = "167217327520"
  region           = "us-east-1"
  hosted_zone_id   = "Z0974146XEXJDMNXU573"
  hosted_zone_name = "stokd.cloud"
  deploy_role_name = "stokd-agent-validation-deploy"
  deploy_role_arn  = "arn:aws:iam::${local.account_id}:role/${local.deploy_role_name}"

  manifest_version = 1
  replica_set      = "agent-rs"

  stage_identities = {
    "source-val12" = {
      domain        = "agent-source-val12.stokd.cloud"
      database_name = "agent_source_val12"
      recovery_mode = "active"
    }
    "restore-val12" = {
      domain        = "agent-restore-val12.stokd.cloud"
      database_name = "agent_restore_val12"
      recovery_mode = "restored_observation"
    }
  }

  identity      = local.stage_identities[var.stage]
  domain        = local.identity.domain
  database_name = local.identity.database_name
  recovery_mode = local.identity.recovery_mode

  # The restore stage reads the source stage's retained custody. The source
  # stage never reads the restore stage.
  is_restore   = var.stage == "restore-val12"
  source_stage = "source-val12"

  artifact_bucket_name = "stokd-agent-artifacts-${var.stage}-${local.account_id}"
  backup_bucket_name   = "stokd-agent-backups-${var.stage}-${local.account_id}"

  source_artifact_bucket_name = "stokd-agent-artifacts-${local.source_stage}-${local.account_id}"
  source_backup_bucket_name   = "stokd-agent-backups-${local.source_stage}-${local.account_id}"

  cluster_name      = "stokd-agent-api-${var.stage}"
  api_service_name  = "stokd-agent-api-${var.stage}"
  api_cluster_arn   = "arn:aws:ecs:${local.region}:${local.account_id}:cluster/${local.cluster_name}"
  api_service_arn   = "arn:aws:ecs:${local.region}:${local.account_id}:service/${local.cluster_name}/${local.api_service_name}"
  mongo_role_name   = "stokd-agent-workload-mongo-${var.stage}"
  mongo_service_dns = "mongo-${var.stage}.sst:27017"

  repository_arn    = "arn:aws:ecr:${local.region}:${local.account_id}:repository/stokd-agent-runtime"
  log_group_name    = "/stokd-agent/${var.stage}/api"
  log_group_arn     = "arn:aws:logs:${local.region}:${local.account_id}:log-group:${local.log_group_name}"
  boundary_arn      = "arn:aws:iam::${local.account_id}:policy/stokd-agent-workload-boundary"
  manifest_param    = "/stokd-agent/${var.stage}/infrastructure-manifest/v1"
  certificate_param = "/stokd-agent/shared/validation-certificate/v1"

  azs = ["us-east-1a", "us-east-1b"]

  # Custody classes drive retention. `persistent` resources hold customer state
  # and are never destroyed by a stage teardown; `runtime` and `stateless`
  # resources are rebuildable.
  persistent_tags = { Custody = "persistent" }
  runtime_tags    = { Custody = "runtime" }
  stateless_tags  = { Custody = "stateless" }
}

# Fail closed before any resource is touched if the caller is not the bounded
# deploy role in the expected account. This replaces assertSstDeploymentIdentity.
data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

resource "terraform_data" "deployment_identity_guard" {
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == local.account_id
      error_message = "AWS provider account does not match the Agent validation boundary ${local.account_id}."
    }

    precondition {
      condition     = data.aws_region.current.name == local.region
      error_message = "AWS region must equal ${local.region}."
    }

    precondition {
      condition     = !endswith(data.aws_caller_identity.current.arn, ":root")
      error_message = "AWS account root is forbidden for Agent deployments."
    }

    precondition {
      condition = (
        data.aws_caller_identity.current.arn == local.deploy_role_arn ||
        startswith(data.aws_caller_identity.current.arn, "arn:aws:sts::${local.account_id}:assumed-role/${local.deploy_role_name}/")
      )
      error_message = "Terraform requires the bounded ${local.deploy_role_name} role."
    }
  }
}

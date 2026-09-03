output "stage" {
  description = "Deployed Agent validation stage."
  value       = var.stage
}

output "api_url" {
  description = "Public TLS endpoint for the Agent API."
  value       = "https://${local.domain}"
}

output "api_service_arn" {
  description = "ECS service ARN for the Agent API."
  value       = local.api_service_arn
}

output "api_task_definition_arn" {
  description = "Exact task definition revision currently deployed."
  value       = aws_ecs_task_definition.api.arn
}

output "source_digest" {
  description = "Source commit the deployed images were built from."
  value       = var.source_digest
}

output "manifest_parameter" {
  description = "SSM parameter holding the deployed infrastructure manifest."
  value       = aws_ssm_parameter.infrastructure_manifest.name
}

output "mongo_instance_id" {
  description = "MongoDB host instance."
  value       = aws_instance.mongo.id
}

output "database_volume_id" {
  description = "Retained MongoDB data volume."
  value       = aws_ebs_volume.data.id
}

# Everything the Terraform handoff has to enumerate as retained custody. A
# stage teardown must leave every one of these in place.
output "retained_custody" {
  description = "Physical resources that survive a stage teardown."

  value = {
    kms_key_arn     = aws_kms_key.data.arn
    kms_alias       = aws_kms_alias.data.name
    artifact_bucket = aws_s3_bucket.custody["artifacts"].bucket
    backup_bucket   = aws_s3_bucket.custody["backups"].bucket
    data_volume_id  = aws_ebs_volume.data.id
    secret_arns = {
      runtime   = local.runtime_secret_arn
      migration = local.migration_secret_arn
      backup    = local.backup_secret_arn
    }
    manifest_parameter = aws_ssm_parameter.infrastructure_manifest.name
  }
}

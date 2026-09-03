# ── Infrastructure manifest ───────────────────────────────────────────────────
# In the SST layout this parameter was load-bearing: the API app read it to
# discover the data app's resources. Terraform wires those references directly,
# so the manifest is no longer a deploy-ordering mechanism. It is retained
# because the host scripts and the Work 1.2 validation tooling read it, and
# because it is the single readback surface that states what was actually
# deployed for a stage.

locals {
  infrastructure_manifest = {
    schemaVersion   = "1.0"
    manifestVersion = local.manifest_version
    accountId       = local.account_id
    region          = local.region
    stage           = var.stage
    sourceDigest    = var.source_digest
    recoveryMode    = local.recovery_mode

    cluster = {
      id          = aws_ecs_cluster.api.id
      arn         = local.api_cluster_arn
      serviceName = local.api_service_name
      serviceArn  = local.api_service_arn
    }

    vpc = {
      id                    = aws_vpc.agent.id
      containerSubnets      = [for subnet in aws_subnet.private : subnet.id]
      loadBalancerSubnets   = [for subnet in aws_subnet.public : subnet.id]
      loadBalancerCidrs     = [for subnet in aws_subnet.public : subnet.cidr_block]
      apiSecurityGroupId    = aws_security_group.api.id
      mongoSecurityGroupId  = aws_security_group.mongo.id
      cloudmapNamespaceId   = aws_service_discovery_private_dns_namespace.agent.id
      cloudmapNamespaceName = aws_service_discovery_private_dns_namespace.agent.name

      # Endpoint-only egress. Both stay empty by construction; the validation
      # tooling fails the stage if either is ever non-empty.
      natGatewayIds = []
      elasticIpIds  = []
    }

    mongo = {
      host                = local.mongo_service_dns
      databaseName        = local.database_name
      replicaSet          = local.replica_set
      instanceId          = aws_instance.mongo.id
      networkInterfaceId  = aws_network_interface.mongo.id
      volumeId            = aws_ebs_volume.data.id
      discoveryServiceId  = aws_service_discovery_service.mongo.id
      discoveryInstanceId = aws_service_discovery_instance.mongo.instance_id
    }

    custody = {
      kmsKeyArn      = aws_kms_key.data.arn
      kmsAliasName   = aws_kms_alias.data.name
      artifactBucket = aws_s3_bucket.custody["artifacts"].bucket
      backupBucket   = aws_s3_bucket.custody["backups"].bucket
    }

    secrets = {
      runtimeArn   = local.runtime_secret_arn
      migrationArn = local.migration_secret_arn
      backupArn    = local.backup_secret_arn
    }

    images = {
      mongodb     = var.mongo_image
      maintenance = var.maintenance_image
    }

    hostedZoneId = local.hosted_zone_id
  }
}

resource "aws_ssm_parameter" "infrastructure_manifest" {
  name      = local.manifest_param
  type      = "String"
  data_type = "text"
  tier      = "Standard"
  value     = jsonencode(local.infrastructure_manifest)
  tags      = local.persistent_tags

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [aws_volume_attachment.data]
}

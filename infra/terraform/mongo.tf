# ── MongoDB host ──────────────────────────────────────────────────────────────
# A single EC2 host with a retained, separately-managed data volume. The host is
# disposable; the volume is not. Replacing the instance must never replace the
# volume, which is why they are distinct resources joined by an attachment.

data "aws_iam_policy_document" "ec2_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "mongo" {
  name                 = local.mongo_role_name
  assume_role_policy   = data.aws_iam_policy_document.ec2_trust.json
  permissions_boundary = local.boundary_arn
  tags                 = local.runtime_tags
}

data "aws_iam_policy_document" "mongo" {
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "ExactRuntimeImages"
    effect    = "Allow"
    resources = [local.repository_arn]

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
  }

  statement {
    sid    = "ExactTargetSecrets"
    effect = "Allow"

    actions = concat(
      ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:ListSecretVersionIds"],
      local.is_restore ? ["secretsmanager:PutSecretValue"] : [],
    )

    resources = [
      local.runtime_secret_arn,
      local.migration_secret_arn,
      local.backup_secret_arn,
    ]
  }

  dynamic "statement" {
    for_each = local.is_restore ? [1] : []

    content {
      sid       = "SourceSecretsReadOnly"
      effect    = "Allow"
      resources = local.source_secret_arns

      actions = [
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:ListSecretVersionIds",
      ]
    }
  }

  statement {
    sid       = "ExactKeyUse"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn]
  }

  # A restore must decrypt material written under the source stage's key. That
  # key's ARN is not knowable at plan time without coupling the two stages, so
  # it is reached by project tag instead -- the same shape the deploy boundary
  # uses. Read-only actions only; the restore stage never writes with it.
  dynamic "statement" {
    for_each = local.is_restore ? [1] : []

    content {
      sid       = "SourceStageKeyReadOnly"
      effect    = "Allow"
      actions   = ["kms:Decrypt", "kms:DescribeKey"]
      resources = ["arn:aws:kms:${local.region}:${local.account_id}:key/*"]

      condition {
        test     = "StringEquals"
        variable = "aws:ResourceTag/Project"
        values   = ["stokd-agent"]
      }
    }
  }

  statement {
    sid    = "VersionedCustody"
    effect = "Allow"

    actions = [
      "s3:GetBucketLocation",
      "s3:GetBucketVersioning",
      "s3:ListBucket",
      "s3:ListBucketVersions",
    ]

    resources = concat(
      [aws_s3_bucket.custody["artifacts"].arn, aws_s3_bucket.custody["backups"].arn],
      local.is_restore ? [
        "arn:aws:s3:::${local.source_artifact_bucket_name}",
        "arn:aws:s3:::${local.source_backup_bucket_name}",
      ] : [],
    )
  }

  statement {
    sid    = "TargetVersionedObjects"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:PutObjectTagging",
      "s3:AbortMultipartUpload",
    ]

    resources = [
      "${aws_s3_bucket.custody["artifacts"].arn}/*",
      "${aws_s3_bucket.custody["backups"].arn}/*",
    ]
  }

  dynamic "statement" {
    for_each = local.is_restore ? [1] : []

    content {
      sid     = "SourceObjectsReadOnly"
      effect  = "Allow"
      actions = ["s3:GetObject", "s3:GetObjectVersion"]

      resources = [
        "arn:aws:s3:::${local.source_artifact_bucket_name}/*",
        "arn:aws:s3:::${local.source_backup_bucket_name}/*",
      ]
    }
  }

  statement {
    sid       = "InstanceCustodyReadback"
    effect    = "Allow"
    actions   = ["ec2:DescribeInstances", "ec2:DescribeVolumes"]
    resources = ["*"]
  }

  statement {
    sid       = "SsmManagedInstance"
    effect    = "Allow"
    resources = ["*"]

    actions = [
      "ssm:UpdateInstanceInformation",
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
      "ec2messages:AcknowledgeMessage",
      "ec2messages:DeleteMessage",
      "ec2messages:FailMessage",
      "ec2messages:GetEndpoint",
      "ec2messages:GetMessages",
      "ec2messages:SendReply",
    ]
  }

  # The host may drain and re-admit the API service around a migration. It may
  # not create work.
  statement {
    sid       = "ExactApiAdmission"
    effect    = "Allow"
    actions   = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = [local.api_service_arn]
  }

  statement {
    sid       = "NoRedispatch"
    effect    = "Deny"
    resources = ["*"]

    actions = [
      "ecs:RunTask",
      "events:PutEvents",
      "lambda:InvokeFunction",
      "sns:Publish",
      "sqs:SendMessage",
      "states:StartExecution",
    ]
  }

  statement {
    sid       = "NoPersistentDeletion"
    effect    = "Deny"
    resources = ["*"]

    actions = [
      "ec2:DeleteVolume",
      "kms:ScheduleKeyDeletion",
      "s3:DeleteBucket",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "secretsmanager:DeleteSecret",
    ]
  }

  # No model-invoke authority, stated explicitly. The permissions boundary
  # already withholds it by omission; this makes an IAM policy simulation report
  # an explicit deny rather than an implicit one, so the readback evidence is
  # unambiguous.
  statement {
    sid       = "NoModelInvocation"
    effect    = "Deny"
    resources = ["*"]

    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:Converse",
      "bedrock:ConverseStream",
    ]
  }
}


resource "aws_iam_role_policy" "mongo" {
  name   = "stokd-agent-mongo-${var.stage}"
  role   = aws_iam_role.mongo.id
  policy = data.aws_iam_policy_document.mongo.json
}

# The data volume is tagged pending-v1 at creation and flipped to initialized-v1
# exactly once, by the host, after a successful first format. This policy allows
# that single transition and nothing else, so a re-run cannot silently reformat
# a volume that already holds data.
data "aws_iam_policy_document" "mongo_volume_initialization" {
  statement {
    sid       = "FinalizeExactFreshVolumeOnce"
    effect    = "Allow"
    actions   = ["ec2:CreateTags"]
    resources = [aws_ebs_volume.data.arn]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/Project"
      values   = ["stokd-agent"]
    }

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/Stage"
      values   = [var.stage]
    }

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/InitializationState"
      values   = ["pending-v1"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/InitializationState"
      values   = ["initialized-v1"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["InitializationState"]
    }
  }
}

resource "aws_iam_role_policy" "mongo_volume_initialization" {
  name   = "stokd-agent-mongo-volume-init-${var.stage}"
  role   = aws_iam_role.mongo.id
  policy = data.aws_iam_policy_document.mongo_volume_initialization.json
}

resource "aws_iam_instance_profile" "mongo" {
  name = local.mongo_role_name
  role = aws_iam_role.mongo.name
}

# ── Host networking and storage ───────────────────────────────────────────────

locals {
  first_private_az     = local.azs[0]
  first_private_subnet = aws_subnet.private[local.first_private_az]
}

resource "aws_network_interface" "mongo" {
  subnet_id         = local.first_private_subnet.id
  security_groups   = [aws_security_group.mongo.id]
  source_dest_check = true
  tags              = local.runtime_tags
}

resource "aws_ebs_volume" "data" {
  availability_zone = local.first_private_az
  encrypted         = true
  kms_key_id        = aws_kms_key.data.arn
  size              = 30
  type              = "gp3"
  iops              = 3000
  throughput        = 125

  tags = merge(local.persistent_tags, { InitializationState = "pending-v1" })

  lifecycle {
    prevent_destroy = true

    # The host owns InitializationState after first boot.
    ignore_changes = [tags]
  }
}

resource "aws_service_discovery_service" "mongo" {
  name = "mongo-${var.stage}"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.agent.id
    routing_policy = "MULTIVALUE"

    dns_records {
      ttl  = 30
      type = "A"
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  tags = local.runtime_tags
}

resource "aws_service_discovery_instance" "mongo" {
  instance_id = "mongo-${var.stage}"
  service_id  = aws_service_discovery_service.mongo.id

  attributes = {
    AWS_INSTANCE_IPV4 = aws_network_interface.mongo.private_ip
  }
}

# ── Host bootstrap ────────────────────────────────────────────────────────────

locals {
  host_files = {
    "host-common"                = "host-common.sh"
    "mongo-service"              = "host-mongo-service.sh"
    "migrate-host"               = "host-migrate.sh"
    "validation-seed-host"       = "host-validation-seed.sh"
    "backup-host"                = "host-backup.sh"
    "restore-host"               = "host-restore.sh"
    "host-bootstrap"             = "host-bootstrap.sh"
    "stokd-agent-mongo.service"  = "systemd/stokd-agent-mongo.service"
    "stokd-agent-backup.service" = "systemd/stokd-agent-backup.service"
    "stokd-agent-backup.timer"   = "systemd/stokd-agent-backup.timer"
  }

  host_environment = join("\n", [
    "AGENT_AWS_ACCOUNT_ID=${local.account_id}",
    "AWS_REGION=${local.region}",
    "AGENT_STAGE=${var.stage}",
    "AGENT_DATABASE_NAME=${local.database_name}",
    "AGENT_MONGO_HOST=${local.mongo_service_dns}",
    "AGENT_MONGO_IMAGE=${var.mongo_image}",
    "AGENT_MAINTENANCE_IMAGE=${var.maintenance_image}",
    "AGENT_VOLUME_ID=${aws_ebs_volume.data.id}",
    "AGENT_KMS_KEY_ARN=${aws_kms_key.data.arn}",
    "AGENT_ARTIFACT_BUCKET=${aws_s3_bucket.custody["artifacts"].bucket}",
    "AGENT_BACKUP_BUCKET=${aws_s3_bucket.custody["backups"].bucket}",
    "AGENT_RUNTIME_SECRET_ARN=${local.runtime_secret_arn}",
    "AGENT_MIGRATION_SECRET_ARN=${local.migration_secret_arn}",
    "AGENT_BACKUP_SECRET_ARN=${local.backup_secret_arn}",
    "AGENT_SOURCE_BACKUP_BUCKET=${local.source_backup_bucket_name}",
    "AGENT_SOURCE_RUNTIME_SECRET_ARN=${local.source_runtime_secret_arn}",
    "AGENT_SOURCE_MIGRATION_SECRET_ARN=${local.source_migration_secret_arn}",
    "AGENT_SOURCE_BACKUP_SECRET_ARN=${local.source_backup_secret_arn}",
    "AGENT_API_CLUSTER_ARN=${local.api_cluster_arn}",
    "AGENT_API_SERVICE_ARN=${local.api_service_arn}",
  ])

  # The host scripts total well past EC2's 16 KB user_data limit, so they are
  # staged in the artifacts bucket under this item's evidence prefix (the only
  # object prefix the deploy role may write) and pulled down at boot through the
  # S3 gateway endpoint. Keying by source digest means a host always boots the
  # exact scripts from the commit it was deployed from.
  host_object_prefix = "validation/work-1.2/${var.stage}/host"

  # The host scripts keep a stable key so an upload writes a NEW OBJECT VERSION
  # rather than superseding a digest-keyed path. Nothing is ever deleted, which
  # is what the retained-custody deny on s3:DeleteObjectVersion requires.
  # Provenance still comes from S3 versioning plus this digest, which is folded
  # into user_data so a script change replaces the host.
  host_scripts_digest = sha256(join("", [
    for name in sort(keys(local.host_files)) : filesha256("${path.module}/../runtime/${local.host_files[name]}")
  ]))

  mongo_user_data = <<-EOT
    #!/bin/bash
    # host-scripts: ${local.host_scripts_digest}
    set -euo pipefail
    install -d -m 0700 /etc/stokd-agent /opt/stokd-agent/bin
    bucket='${aws_s3_bucket.custody["artifacts"].bucket}'
    prefix='${local.host_object_prefix}'
    for name in ${join(" ", [for name in keys(local.host_files) : "'${name}'"])}; do
      case "$name" in
        *.service|*.timer) target="/etc/systemd/system/$name"; mode=0444 ;;
        *)                 target="/opt/stokd-agent/bin/$name";  mode=0555 ;;
      esac
      aws s3 cp "s3://$bucket/$prefix/$name" "$target" --region ${local.region} --quiet
      chmod "$mode" "$target"
    done
    cat > /etc/stokd-agent/host.env <<'AGENT_ENV'
    ${local.host_environment}
    AGENT_ENV
    chmod 0400 /etc/stokd-agent/host.env
    /opt/stokd-agent/bin/host-bootstrap
  EOT
}

resource "aws_s3_object" "host_files" {
  for_each = local.host_files

  bucket                 = aws_s3_bucket.custody["artifacts"].id
  key                    = "${local.host_object_prefix}/${each.key}"
  content                = file("${path.module}/../runtime/${each.value}")
  server_side_encryption = "aws:kms"
  kms_key_id             = aws_kms_key.data.arn

  # Versioning too, not just policy and encryption. Every evidence pointer this
  # item writes is a (bucket, key, versionId) triple; an object written into a
  # bucket whose versioning is not yet on has no version to point at.
  depends_on = [
    aws_s3_bucket_policy.custody,
    aws_s3_bucket_server_side_encryption_configuration.custody,
    aws_s3_bucket_versioning.custody,
  ]
}

resource "aws_instance" "mongo" {
  ami                  = var.mongo_ami_id
  instance_type        = "t3.small"
  iam_instance_profile = aws_iam_instance_profile.mongo.name

  network_interface {
    network_interface_id = aws_network_interface.mongo.id
    device_index         = 0
  }

  # IMDSv2 required; the hop limit of 1 keeps container workloads from reaching
  # instance credentials.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    encrypted   = true
    kms_key_id  = aws_kms_key.data.arn
    volume_type = "gp3"

    # The pinned AMI's root snapshot is 30 GiB, so the root volume cannot be
    # smaller. This is the OS disk only; MongoDB data lives on the separate
    # retained volume.
    volume_size           = 30
    delete_on_termination = true
    tags                  = local.runtime_tags
  }

  user_data                   = local.mongo_user_data
  user_data_replace_on_change = true

  # No volume_tags: it conflicts with root_block_device.tags, which already
  # tags the root volume. The data volume is a separate resource with its own
  # persistent-custody tags.
  tags = local.runtime_tags

  # The endpoints alone are not enough: without the rules that let this host
  # REACH them, user_data's S3 download fails and the host comes up with no
  # /opt/stokd-agent/bin at all. Nothing in the configuration references these
  # rules, so only an explicit dependency orders them before the boot that
  # needs them.
  depends_on = [
    aws_s3_object.host_files,
    aws_iam_role_policy.mongo,
    aws_iam_role_policy.mongo_volume_initialization,
    aws_service_discovery_instance.mongo,
    aws_vpc_endpoint.s3,
    aws_vpc_endpoint.interface,
    aws_vpc_security_group_ingress_rule.endpoints_from_mongo,
    aws_vpc_security_group_egress_rule.mongo_to_endpoints,
    aws_vpc_security_group_egress_rule.dns_udp,
    aws_vpc_security_group_egress_rule.dns_tcp,
    aws_vpc_security_group_egress_rule.s3_endpoint,
    # The S3 endpoint is a GATEWAY: it works by route, not by ENI. Without the
    # subnet's association to the route table that carries it, S3 is simply
    # unroutable and user_data's download hangs until cloud-init gives up --
    # while the interface endpoints, which need no route, keep working and make
    # the host look reachable.
    aws_route_table_association.private,
  ]
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  instance_id                    = aws_instance.mongo.id
  volume_id                      = aws_ebs_volume.data.id
  stop_instance_before_detaching = true
}

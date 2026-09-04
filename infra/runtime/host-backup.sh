#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC1091
source /opt/stokd-agent/bin/host-common
agent_load_config
[[ "$AGENT_STAGE" == source-val12 ]] || { echo 'daily backup is source-stage only' >&2; exit 7; }
install -d -m 0700 /run/stokd-agent /run/stokd-agent/raw
agent_prepare_private_registry
agent_pull_image "$AGENT_MAINTENANCE_IMAGE"
instance_id="$(agent_verify_instance)"
agent_mount_volume
systemctl is-active --quiet stokd-agent-mongo.service || { echo 'Mongo service is not active' >&2; exit 7; }
exec 9>/run/stokd-agent/maintenance.lock
flock -w 600 9 || { echo 'another Agent maintenance operation owns the host' >&2; exit 7; }
agent_assert_no_active_restore || { echo 'backup refused while a restore is incomplete' >&2; exit 7; }

api_quiesced=false
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  rm -f /run/stokd-agent/raw/*.secret /run/stokd-agent/{backup-config,backup-credentials,source-resource-proof,admission-quiesce-proof,aws-process}.json /run/stokd-agent/aws-config
  if [[ "$api_quiesced" == true ]]; then
    if systemctl is-active --quiet stokd-agent-mongo.service; then
      agent_aws ecs update-service --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --service "$AGENT_API_SERVICE_ARN" --desired-count 1 >/dev/null || status=7
      agent_aws ecs wait services-stable --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --services "$AGENT_API_SERVICE_ARN" || status=7
    else
      echo 'API admission remains disabled because MongoDB is unhealthy' >&2
      status=7
    fi
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM
initial_counts="$(agent_aws ecs describe-services --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --services "$AGENT_API_SERVICE_ARN" --query 'services[0].[desiredCount,runningCount]' --output text)"
[[ "$initial_counts" == $'1\t1' ]] || { echo 'backup requires the sole API admission service at exact 1/1 state' >&2; exit 7; }
agent_aws ecs update-service --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --service "$AGENT_API_SERVICE_ARN" --desired-count 0 >/dev/null
api_quiesced=true
agent_aws ecs wait services-stable --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --services "$AGENT_API_SERVICE_ARN"
quiesced_counts="$(agent_aws ecs describe-services --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --services "$AGENT_API_SERVICE_ARN" --query 'services[0].[desiredCount,runningCount]' --output text)"
[[ "$quiesced_counts" == $'0\t0' ]] || { echo 'backup refused while API write admission remains active' >&2; exit 7; }
runtime_version="$(agent_aws secretsmanager list-secret-version-ids --region us-east-1 --secret-id "$AGENT_RUNTIME_SECRET_ARN" --include-deprecated --query "Versions[?contains(VersionStages, 'AWSCURRENT')].VersionId | [0]" --output text)"
migration_version="$(agent_aws secretsmanager list-secret-version-ids --region us-east-1 --secret-id "$AGENT_MIGRATION_SECRET_ARN" --include-deprecated --query "Versions[?contains(VersionStages, 'AWSCURRENT')].VersionId | [0]" --output text)"
backup_version="$(agent_aws secretsmanager list-secret-version-ids --region us-east-1 --secret-id "$AGENT_BACKUP_SECRET_ARN" --include-deprecated --query "Versions[?contains(VersionStages, 'AWSCURRENT')].VersionId | [0]" --output text)"
for version in "$runtime_version" "$migration_version" "$backup_version"; do [[ "$version" =~ ^[A-Za-z0-9-]{32,64}$ ]] || exit 7; done
agent_fetch_secret_version "$AGENT_RUNTIME_SECRET_ARN" "$runtime_version" /run/stokd-agent/raw/runtime.secret
agent_fetch_secret_version "$AGENT_BACKUP_SECRET_ARN" "$backup_version" /run/stokd-agent/raw/backup.secret
agent_materialize_credentials /run/stokd-agent/backup-credentials.json \
  runtimePassword /run/stokd-agent/raw/runtime.secret \
  backupPassword /run/stokd-agent/raw/backup.secret

resource_ids="{\"artifactBucket\":\"$AGENT_ARTIFACT_BUCKET\",\"backupBucket\":\"$AGENT_BACKUP_BUCKET\",\"databaseVolumeId\":\"$AGENT_VOLUME_ID\",\"kmsKeyArn\":\"$AGENT_KMS_KEY_ARN\",\"mongoInstanceId\":\"$instance_id\"}"
secret_version_ids="{\"runtime\":\"$runtime_version\",\"migration\":\"$migration_version\",\"backup\":\"$backup_version\"}"
printf '%s' "$resource_ids" | agent_materialize_canonical_json /run/stokd-agent/source-resource-proof.json
backup_id="$(date -u +%Y%m%dT%H%M%SZ)"
observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
expires_at="$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)"
quiesce_proof="{\"schemaVersion\":\"1.0\",\"proofId\":\"aqp_$backup_id\",\"sourceEnvironment\":\"$AGENT_STAGE\",\"apiDesiredCount\":0,\"apiRunningCount\":0,\"observedAt\":\"$observed_at\",\"expiresAt\":\"$expires_at\",\"sourceResourceIds\":$resource_ids}"
printf '%s' "$quiesce_proof" | agent_materialize_canonical_json /run/stokd-agent/admission-quiesce-proof.json
config="{\"schemaVersion\":\"1.0\",\"command\":\"backup\",\"environment\":\"$AGENT_STAGE\",\"databaseName\":\"$AGENT_DATABASE_NAME\",\"replicaSet\":\"agent-rs\",\"mongoHost\":\"$AGENT_MONGO_HOST\",\"mongodumpPath\":\"/usr/bin/mongodump\",\"workDirectory\":\"/var/lib/stokd-agent/backups\",\"sourceResourceIds\":$resource_ids,\"sourceSecretVersionIds\":$secret_version_ids,\"sourceResourceProofPath\":\"/run/stokd-agent/source-resource-proof.json\",\"admissionQuiesceProofPath\":\"/run/stokd-agent/admission-quiesce-proof.json\",\"admissionQuiesceProbe\":{\"kind\":\"ecs-describe-service\",\"clusterArn\":\"$AGENT_API_CLUSTER_ARN\",\"serviceArn\":\"$AGENT_API_SERVICE_ARN\"},\"region\":\"us-east-1\",\"archiveObject\":{\"bucket\":\"$AGENT_BACKUP_BUCKET\",\"key\":\"operational/$backup_id/mongodb.archive.gz\",\"kmsKeyArn\":\"$AGENT_KMS_KEY_ARN\"},\"manifestObject\":{\"bucket\":\"$AGENT_BACKUP_BUCKET\",\"key\":\"operational/$backup_id/manifest.json\",\"kmsKeyArn\":\"$AGENT_KMS_KEY_ARN\"}}"
printf '%s' "$config" | agent_materialize_canonical_json /run/stokd-agent/backup-config.json
agent_materialize_aws_credentials
output="/var/lib/stokd-agent/receipts/backup-$backup_id.json"
agent_run_maintenance backup /run/stokd-agent/backup-config.json /run/stokd-agent/backup-credentials.json "$output"
[[ "$(stat -c '%a:%u' "$output")" == '600:0' ]] || { echo 'backup receipt custody is invalid' >&2; exit 7; }
cat "$output"

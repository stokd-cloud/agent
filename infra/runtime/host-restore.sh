#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC1091
source /opt/stokd-agent/bin/host-common

declare -A supplied=()
while (($#)); do
  case "$1" in
    --operation-id|--source-bucket|--manifest-key|--manifest-version-id|--manifest-sha256|--archive-key|--archive-version-id|--archive-sha256|--target-stage)
      [[ -z "${supplied[$1]:-}" && -n "${2:-}" ]] || { echo "duplicate or missing restore argument $1" >&2; exit 2; }
      supplied[$1]="$2"; shift 2 ;;
    *) echo "unrecognized restore argument $1" >&2; exit 2 ;;
  esac
done
for required in --operation-id --source-bucket --manifest-key --manifest-version-id --manifest-sha256 --archive-key --archive-version-id --archive-sha256 --target-stage; do
  [[ -n "${supplied[$required]:-}" ]] || { echo "missing restore argument $required" >&2; exit 2; }
done
operation_id="${supplied[--operation-id]}"
source_bucket="${supplied[--source-bucket]}"
manifest_key="${supplied[--manifest-key]}"
manifest_version="${supplied[--manifest-version-id]}"
manifest_sha="${supplied[--manifest-sha256]}"
archive_key="${supplied[--archive-key]}"
archive_version="${supplied[--archive-version-id]}"
archive_sha="${supplied[--archive-sha256]}"
[[ "$operation_id" =~ ^[a-z0-9][a-z0-9-]{2,80}$ ]] || exit 2
[[ "$source_bucket" == stokd-agent-backups-source-val12-167217327520 ]] || exit 7
[[ "${supplied[--target-stage]}" == restore-val12 ]] || exit 7
for key in "$manifest_key" "$archive_key"; do [[ "$key" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,512}$ && "$key" != *..* ]] || exit 2; done
for version in "$manifest_version" "$archive_version"; do [[ "$version" =~ ^[A-Za-z0-9._=+/-]{1,1000}$ ]] || exit 2; done
[[ "$manifest_sha" =~ ^[a-f0-9]{64}$ && "$archive_sha" =~ ^[a-f0-9]{64}$ ]] || exit 2

agent_load_config
[[ "$AGENT_STAGE" == restore-val12 ]] || { echo 'restore controller may run only on restore-val12' >&2; exit 7; }
[[ "$AGENT_SOURCE_BACKUP_BUCKET" == "$source_bucket" ]] || exit 7
[[ "$AGENT_API_CLUSTER_ARN" == 'arn:aws:ecs:us-east-1:167217327520:cluster/stokd-agent-api-restore-val12' ]] || exit 7
[[ "$AGENT_API_SERVICE_ARN" == 'arn:aws:ecs:us-east-1:167217327520:service/stokd-agent-api-restore-val12/stokd-agent-api-restore-val12' ]] || exit 7
install -d -m 0700 /run/stokd-agent /run/stokd-agent/raw /var/lib/stokd-agent/receipts /var/lib/stokd-agent/restore
agent_prepare_private_registry
agent_pull_image "$AGENT_MAINTENANCE_IMAGE"
instance_id="$(agent_verify_instance)"
agent_mount_volume
exec 9>/run/stokd-agent/maintenance.lock
flock -w 600 9 || { echo 'another Agent maintenance operation owns the host' >&2; exit 7; }

state_path="/var/lib/stokd-agent/receipts/restore-operation-$operation_id.json"
operation_dir="/var/lib/stokd-agent/restore/$operation_id"
offline_receipt="/var/lib/stokd-agent/receipts/restore-offline-$operation_id.json"
final_report="/var/lib/stokd-agent/receipts/restore-finalize-$operation_id.json"
offline_container="stokd-agent-offline-$operation_id"
input_binding="$(printf '%s\0' \
  "$operation_id" "$source_bucket" "$manifest_key" "$manifest_version" "$manifest_sha" "$archive_key" "$archive_version" "$archive_sha" \
  "$instance_id" "$AGENT_VOLUME_ID" "$AGENT_KMS_KEY_ARN" "$AGENT_ARTIFACT_BUCKET" "$AGENT_BACKUP_BUCKET" \
  "$AGENT_MONGO_HOST" "$AGENT_DATABASE_NAME" 'agent-rs' \
  "$AGENT_RUNTIME_SECRET_ARN" "$AGENT_MIGRATION_SECRET_ARN" "$AGENT_BACKUP_SECRET_ARN" \
  "$AGENT_SOURCE_RUNTIME_SECRET_ARN" "$AGENT_SOURCE_MIGRATION_SECRET_ARN" "$AGENT_SOURCE_BACKUP_SECRET_ARN" \
  "$AGENT_MONGO_IMAGE" "$AGENT_MAINTENANCE_IMAGE" "$AGENT_API_CLUSTER_ARN" "$AGENT_API_SERVICE_ARN" 'restore-val12' \
  | sha256sum | awk '{print $1}')"
[[ "$input_binding" =~ ^[a-f0-9]{64}$ ]] || exit 7
agent_bind_active_restore "$state_path" "$operation_id" "$input_binding" >/dev/null
agent_restore_state "$state_path" "$operation_id" "$input_binding" init >/dev/null

read_state() {
  IFS=$'\t' read -r phase prior_runtime_version new_runtime_version prior_migration_version new_migration_version prior_backup_version new_backup_version \
    < <(agent_restore_state "$state_path" "$operation_id" "$input_binding" fields)
}
read_state

remove_owned_offline_container() {
  local id stage operation network
  id="$(docker ps -aq --filter "name=^/${offline_container}$")"
  [[ -n "$id" ]] || return 0
  [[ "$id" != *$'\n'* ]] || { echo 'multiple offline restore containers matched one operation' >&2; return 7; }
  stage="$(docker inspect --format '{{index .Config.Labels "io.stokd.agent.stage"}}' "$id" 2>/dev/null || true)"
  operation="$(docker inspect --format '{{index .Config.Labels "io.stokd.agent.operation"}}' "$id" 2>/dev/null || true)"
  network="$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$id" 2>/dev/null || true)"
  [[ "$stage" == restore-val12 && "$operation" == "$operation_id" && "$network" == none ]] || {
    echo 'refusing to remove an unowned restore container' >&2
    return 7
  }
  docker rm -f "$id" >/dev/null
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  remove_owned_offline_container || status=7
  rm -f /run/stokd-agent/raw/*.secret \
    /run/stokd-agent/{restore-offline-base,restore-offline-config,restore-offline-credentials,restore-finalize-config,restore-finalize-credentials,aws-process}.json \
    /run/stokd-agent/aws-config /run/stokd-agent/offline-mongod.pid /run/stokd-agent/offline-mongod.log
  if [[ -d "$operation_dir" ]]; then
    [[ "$(stat -c '%a:%u' "$operation_dir")" == '700:0' ]] || status=7
    find "$operation_dir" -mindepth 1 -delete 2>/dev/null || status=7
    rmdir "$operation_dir" 2>/dev/null || status=7
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

if [[ "$phase" == complete ]]; then
  [[ "$(stat -c '%a:%u' "$offline_receipt")" == '600:0' && "$(stat -c '%a:%u' "$final_report")" == '600:0' ]] || {
    echo 'completed restore operation has lost receipt custody' >&2
    exit 7
  }
  agent_release_active_restore "$state_path" "$operation_id" "$input_binding" >/dev/null
  cat "$final_report"
  exit 0
fi

# Restore owns API admission for its entire incomplete lifetime. A retry accepts
# only the exact already-quiesced state; any mixed count refuses.
api_counts="$(agent_aws ecs describe-services --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --services "$AGENT_API_SERVICE_ARN" --query 'services[0].[desiredCount,runningCount]' --output text)"
if [[ "$api_counts" == $'1\t1' ]]; then
  agent_aws ecs update-service --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --service "$AGENT_API_SERVICE_ARN" --desired-count 0 >/dev/null
  agent_aws ecs wait services-stable --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --services "$AGENT_API_SERVICE_ARN"
elif [[ "$api_counts" != $'0\t0' ]]; then
  echo 'restore requires the sole API admission service at exact 1/1 or owned 0/0 state' >&2
  exit 7
fi
api_counts="$(agent_aws ecs describe-services --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --services "$AGENT_API_SERVICE_ARN" --query 'services[0].[desiredCount,runningCount]' --output text)"
[[ "$api_counts" == $'0\t0' ]] || { echo 'restore refused while API admission remains active' >&2; exit 7; }

if [[ -e "$operation_dir" ]]; then
  [[ -d "$operation_dir" && ! -L "$operation_dir" && "$(stat -c '%a:%u' "$operation_dir")" == '700:0' ]] || exit 7
  find "$operation_dir" -mindepth 1 -delete
else
  install -d -m 0700 "$operation_dir"
fi
manifest_path="$operation_dir/source-manifest.json"
archive_path="$operation_dir/source-mongodb.archive.gz"
agent_aws_with_data_volume s3api get-object --region us-east-1 --bucket "$source_bucket" --key "$manifest_key" --version-id "$manifest_version" "$manifest_path" >/dev/null
agent_aws_with_data_volume s3api get-object --region us-east-1 --bucket "$source_bucket" --key "$archive_key" --version-id "$archive_version" "$archive_path" >/dev/null
chown 0:0 "$manifest_path" "$archive_path"
chmod 0400 "$manifest_path" "$archive_path"
[[ "$(stat -c '%a:%u' "$manifest_path")" == '400:0' && "$(stat -c '%a:%u' "$archive_path")" == '400:0' ]] || exit 7
[[ "$(sha256sum "$manifest_path" | awk '{print $1}')" == "$manifest_sha" ]] || { echo 'source manifest digest mismatch' >&2; exit 7; }
[[ "$(sha256sum "$archive_path" | awk '{print $1}')" == "$archive_sha" ]] || { echo 'source archive digest mismatch' >&2; exit 7; }

head_field() { agent_aws s3api head-object --region us-east-1 --bucket "$source_bucket" --key "$1" --version-id "$2" --query "$3" --output text; }
manifest_head_version="$(head_field "$manifest_key" "$manifest_version" VersionId)"
manifest_etag="$(head_field "$manifest_key" "$manifest_version" ETag | tr -d '"')"
manifest_length="$(head_field "$manifest_key" "$manifest_version" ContentLength)"
manifest_kms="$(head_field "$manifest_key" "$manifest_version" SSEKMSKeyId)"
manifest_metadata_sha="$(head_field "$manifest_key" "$manifest_version" Metadata.sha256)"
manifest_captured_raw="$(head_field "$manifest_key" "$manifest_version" LastModified)"
manifest_captured="$(date -u -d "$manifest_captured_raw" +%Y-%m-%dT%H:%M:%S.000Z)"
archive_head_version="$(head_field "$archive_key" "$archive_version" VersionId)"
archive_etag="$(head_field "$archive_key" "$archive_version" ETag | tr -d '"')"
archive_length="$(head_field "$archive_key" "$archive_version" ContentLength)"
archive_kms="$(head_field "$archive_key" "$archive_version" SSEKMSKeyId)"
archive_metadata_sha="$(head_field "$archive_key" "$archive_version" Metadata.sha256)"
archive_captured_raw="$(head_field "$archive_key" "$archive_version" LastModified)"
archive_captured="$(date -u -d "$archive_captured_raw" +%Y-%m-%dT%H:%M:%S.000Z)"
[[ "$manifest_head_version" == "$manifest_version" && "$archive_head_version" == "$archive_version" ]] || exit 7
[[ "$manifest_metadata_sha" == "$manifest_sha" && "$archive_metadata_sha" == "$archive_sha" ]] || exit 7
[[ "$manifest_etag" =~ ^[A-Fa-f0-9-]+$ && "$manifest_length" =~ ^[0-9]+$ ]] || exit 7
[[ "$manifest_kms" =~ ^arn:aws:kms:us-east-1:167217327520:key/[a-f0-9-]{36}$ ]] || exit 7
[[ "$archive_length" =~ ^[0-9]+$ && "$archive_kms" =~ ^arn:aws:kms:us-east-1:167217327520:key/[a-f0-9-]{36}$ && "$archive_etag" =~ ^[A-Fa-f0-9-]+$ ]] || exit 7

source_version_fields="$(docker run --rm --network none --read-only --security-opt no-new-privileges --cap-drop ALL \
  -v /var/lib/stokd-agent:/var/lib/stokd-agent:ro \
  --entrypoint /usr/local/bin/node "$AGENT_MAINTENANCE_IMAGE" \
  /opt/stokd-agent/verify-restore-selection.mjs "$manifest_path" "$source_bucket" "$archive_key" "$archive_version" "$archive_sha" "$archive_length" "$archive_kms" "$archive_etag" "$archive_captured")"
IFS=$'\t' read -r source_runtime_version source_migration_version source_backup_version <<<"$source_version_fields"
for version in "$source_runtime_version" "$source_migration_version" "$source_backup_version"; do [[ "$version" =~ ^[A-Za-z0-9-]{32,64}$ ]] || exit 7; done

manifest_custody="{\"bucket\":\"$source_bucket\",\"objectKey\":\"$manifest_key\",\"versionId\":\"$manifest_version\",\"eTag\":\"$manifest_etag\",\"sha256\":\"$manifest_sha\",\"byteLength\":$manifest_length,\"kmsKeyId\":\"$manifest_kms\",\"capturedAt\":\"$manifest_captured\"}"
archive_custody="{\"bucket\":\"$source_bucket\",\"objectKey\":\"$archive_key\",\"versionId\":\"$archive_version\",\"eTag\":\"$archive_etag\",\"sha256\":\"$archive_sha\",\"byteLength\":$archive_length,\"kmsKeyId\":\"$archive_kms\",\"capturedAt\":\"$archive_captured\"}"
target_ids="{\"artifactBucket\":\"$AGENT_ARTIFACT_BUCKET\",\"backupBucket\":\"$AGENT_BACKUP_BUCKET\",\"databaseVolumeId\":\"$AGENT_VOLUME_ID\",\"kmsKeyArn\":\"$AGENT_KMS_KEY_ARN\",\"mongoInstanceId\":\"$instance_id\"}"
source_secret_ids="{\"runtime\":\"$source_runtime_version\",\"migration\":\"$source_migration_version\",\"backup\":\"$source_backup_version\"}"

# Work 1.2 keeps every real source object version under retained custody. Its
# missing-version recovery branch is therefore injected only for the one frozen
# validation artifact, after the storage adapter HEAD-verifies this exact
# manifest record. This scaffold is restricted to restore-val12 above.
work12_injected_object_failure="$(jq -ceS --arg object_key 'agents/validation/valop_work12_durable_fixture/absent-after-backup.bin' '
  (.objects // []) | map(select(.objectKey == $object_key)) as $matches |
  if ($matches | length) == 1 then
    {kind:"injected_missing_version", operationId:"valop_work12_durable_fixture", custody:$matches[0]}
  else
    error("frozen Work 1.2 injected object custody must match exactly one backup-manifest member")
  end
' "$manifest_path")"

if [[ "$phase" == initialized ]]; then
  agent_restore_state "$state_path" "$operation_id" "$input_binding" advance initialized downloaded >/dev/null
  read_state
fi

planned_version() { printf '%s\0' 'stokd-agent/restore-secret/v1' "$operation_id" "$input_binding" "$1" | sha256sum | awk '{print $1}'; }
if [[ "$phase" == downloaded ]]; then
  prior_runtime_version="$(agent_current_secret_version "$AGENT_RUNTIME_SECRET_ARN")"
  prior_migration_version="$(agent_current_secret_version "$AGENT_MIGRATION_SECRET_ARN")"
  prior_backup_version="$(agent_current_secret_version "$AGENT_BACKUP_SECRET_ARN")"
  new_runtime_version="$(planned_version runtime)"
  new_migration_version="$(planned_version migration)"
  new_backup_version="$(planned_version backup)"
  agent_restore_state "$state_path" "$operation_id" "$input_binding" plan-secrets \
    "$prior_runtime_version" "$new_runtime_version" \
    "$prior_migration_version" "$new_migration_version" \
    "$prior_backup_version" "$new_backup_version" >/dev/null
  read_state
fi

prepare_target_secret() {
  local kind="$1" arn="$2" previous_version="$3" next_version="$4"
  local previous_path="/run/stokd-agent/raw/prior-${kind}.secret"
  local next_path="/run/stokd-agent/raw/${kind}.secret"
  local current
  agent_fetch_secret_version "$arn" "$previous_version" "$previous_path"
  current="$(agent_current_secret_version "$arn")"
  if [[ "$current" == "$next_version" ]]; then
    agent_fetch_secret_version "$arn" "$next_version" "$next_path"
  elif [[ "$current" == "$previous_version" ]]; then
    agent_generate_restore_secret "$operation_id" "$next_path"
    agent_put_secret_version "$arn" "$next_version" "$next_path"
    [[ "$(agent_current_secret_version "$arn")" == "$next_version" ]] || { echo 'target secret did not advance to the planned VersionId' >&2; return 7; }
  else
    echo "target ${kind} secret VersionId changed outside this restore operation" >&2
    return 7
  fi
}

case "$phase" in
  secrets_planned|secrets_bound|offline_complete|finalized)
    prepare_target_secret runtime "$AGENT_RUNTIME_SECRET_ARN" "$prior_runtime_version" "$new_runtime_version"
    prepare_target_secret migration "$AGENT_MIGRATION_SECRET_ARN" "$prior_migration_version" "$new_migration_version"
    prepare_target_secret backup "$AGENT_BACKUP_SECRET_ARN" "$prior_backup_version" "$new_backup_version"
    ;;
  *) echo "restore operation has invalid pre-rotation phase $phase" >&2; exit 7 ;;
esac
if [[ "$phase" == secrets_planned ]]; then
  agent_restore_state "$state_path" "$operation_id" "$input_binding" bind-secrets >/dev/null
  read_state
fi
target_secret_ids="{\"runtime\":\"$new_runtime_version\",\"migration\":\"$new_migration_version\",\"backup\":\"$new_backup_version\"}"

agent_fetch_secret_version "$AGENT_SOURCE_RUNTIME_SECRET_ARN" "$source_runtime_version" /run/stokd-agent/raw/source-runtime.secret
agent_fetch_secret_version "$AGENT_SOURCE_MIGRATION_SECRET_ARN" "$source_migration_version" /run/stokd-agent/raw/source-migration.secret
agent_fetch_secret_version "$AGENT_SOURCE_BACKUP_SECRET_ARN" "$source_backup_version" /run/stokd-agent/raw/source-backup.secret
agent_derive_restore_material "$operation_id" /run/stokd-agent/raw/runtime.secret /run/stokd-agent/raw/receipt-hmac.secret /run/stokd-agent/raw/maintenance-session.secret

agent_materialize_credentials /run/stokd-agent/restore-offline-credentials.json \
  runtimePassword /run/stokd-agent/raw/runtime.secret \
  migrationPassword /run/stokd-agent/raw/migration.secret \
  backupPassword /run/stokd-agent/raw/backup.secret \
  maintenanceSessionToken /run/stokd-agent/raw/maintenance-session.secret
offline_base="{\"schemaVersion\":\"1.0\",\"command\":\"restore-offline\",\"manifestPath\":\"$manifest_path\",\"manifestCustody\":$manifest_custody,\"archiveCustody\":$archive_custody,\"localArchivePath\":\"$archive_path\",\"mongorestorePath\":\"/usr/bin/mongorestore\",\"target\":{\"environment\":\"restore-val12\",\"databaseName\":\"agent_restore_val12\",\"replicaSet\":\"agent-rs\",\"memberEndpoint\":\"$AGENT_MONGO_HOST\",\"resourceIds\":$target_ids},\"migrationRoleName\":\"agentMigration_agent_restore_val12\",\"targetSecretVersionIds\":$target_secret_ids,\"requireVersionedObjectCustody\":true}"
printf '%s' "$offline_base" | agent_materialize_canonical_json /run/stokd-agent/restore-offline-base.json

if [[ "$phase" == secrets_bound ]]; then
  systemctl stop stokd-agent-mongo.service
  agent_assert_no_listener 27017 || { echo 'restore refused while MongoDB still listens' >&2; exit 7; }
  [[ -z "$(docker ps --filter name=^/stokd-agent-mongo$ --format '{{.ID}}')" ]] || exit 7
  remove_owned_offline_container
  rm -f "$offline_receipt"
  docker run --rm --name "$offline_container" \
    --label io.stokd.agent.stage=restore-val12 \
    --label "io.stokd.agent.operation=$operation_id" \
    --network none \
    --read-only \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETGID --cap-add SETUID \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=128m \
    -v /run/stokd-agent:/run/stokd-agent:rw \
    -v /var/lib/stokd-agent:/var/lib/stokd-agent:rw \
    -e AGENT_OFFLINE_BASE_CONFIG=/run/stokd-agent/restore-offline-base.json \
    -e AGENT_CREDENTIAL_FILE=/run/stokd-agent/restore-offline-credentials.json \
    -e AGENT_RECEIPT_HMAC_KEY_FILE=/run/stokd-agent/raw/receipt-hmac.secret \
    -e "AGENT_OUTPUT_PATH=$offline_receipt" \
    -e "AGENT_DBPATH_IDENTITY=$AGENT_VOLUME_ID" \
    --entrypoint /opt/stokd-agent/offline-restore-entrypoint \
    "$AGENT_MAINTENANCE_IMAGE"
  [[ "$(stat -c '%a:%u' "$offline_receipt")" == '600:0' ]] || exit 7
  agent_assert_no_listener 27017 || exit 7
  agent_restore_state "$state_path" "$operation_id" "$input_binding" advance secrets_bound offline_complete >/dev/null
  read_state
fi
[[ "$phase" == offline_complete || "$phase" == finalized ]] || { echo "restore operation did not reach offline completion: $phase" >&2; exit 7; }
[[ "$(stat -c '%a:%u' "$offline_receipt")" == '600:0' ]] || exit 7

systemctl start stokd-agent-mongo.service
mongo_ready=false
for _ in $(seq 1 120); do
  if systemctl is-active --quiet stokd-agent-mongo.service && ! agent_assert_no_listener 27017; then mongo_ready=true; break; fi
  sleep 1
done
[[ "$mongo_ready" == true ]] || { echo 'authenticated MongoDB service did not restart' >&2; exit 7; }

agent_materialize_credentials /run/stokd-agent/restore-finalize-credentials.json \
  runtimePassword /run/stokd-agent/raw/runtime.secret \
  migrationPassword /run/stokd-agent/raw/migration.secret \
  backupPassword /run/stokd-agent/raw/backup.secret \
  sourceRuntimePassword /run/stokd-agent/raw/source-runtime.secret \
  sourceMigrationPassword /run/stokd-agent/raw/source-migration.secret \
  sourceBackupPassword /run/stokd-agent/raw/source-backup.secret \
  priorRuntimePassword /run/stokd-agent/raw/prior-runtime.secret \
  priorMigrationPassword /run/stokd-agent/raw/prior-migration.secret \
  priorBackupPassword /run/stokd-agent/raw/prior-backup.secret
finalize="{\"schemaVersion\":\"1.0\",\"command\":\"restore-finalize\",\"manifestPath\":\"$manifest_path\",\"manifestCustody\":$manifest_custody,\"offlineReceiptPath\":\"$offline_receipt\",\"normalMongoHost\":\"$AGENT_MONGO_HOST\",\"target\":{\"environment\":\"restore-val12\",\"databaseName\":\"agent_restore_val12\",\"replicaSet\":\"agent-rs\",\"memberEndpoint\":\"$AGENT_MONGO_HOST\",\"resourceIds\":$target_ids},\"migrationRoleName\":\"agentMigration_agent_restore_val12\",\"sourceSecretVersionIds\":$source_secret_ids,\"targetSecretVersionIds\":$target_secret_ids,\"region\":\"us-east-1\",\"targetArtifactBucket\":\"$AGENT_ARTIFACT_BUCKET\",\"targetArtifactKmsKeyArn\":\"$AGENT_KMS_KEY_ARN\",\"work12InjectedObjectFailure\":$work12_injected_object_failure}"
printf '%s' "$finalize" | agent_materialize_canonical_json /run/stokd-agent/restore-finalize-config.json
agent_materialize_aws_credentials
if [[ "$phase" == offline_complete ]]; then
  rm -f "$final_report"
  agent_run_maintenance restore-finalize /run/stokd-agent/restore-finalize-config.json /run/stokd-agent/restore-finalize-credentials.json "$final_report" /run/stokd-agent/raw/receipt-hmac.secret
  [[ "$(stat -c '%a:%u' "$final_report")" == '600:0' ]] || exit 7
  agent_restore_state "$state_path" "$operation_id" "$input_binding" advance offline_complete finalized >/dev/null
  read_state
fi
[[ "$phase" == finalized && "$(stat -c '%a:%u' "$final_report")" == '600:0' ]] || exit 7

agent_aws ecs update-service --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --service "$AGENT_API_SERVICE_ARN" --desired-count 1 >/dev/null
agent_aws ecs wait services-stable --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --services "$AGENT_API_SERVICE_ARN"
api_counts="$(agent_aws ecs describe-services --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --services "$AGENT_API_SERVICE_ARN" --query 'services[0].[desiredCount,runningCount]' --output text)"
[[ "$api_counts" == $'1\t1' ]] || { echo 'restored API did not return to exact 1/1 readiness' >&2; exit 7; }
agent_restore_state "$state_path" "$operation_id" "$input_binding" advance finalized complete >/dev/null
agent_release_active_restore "$state_path" "$operation_id" "$input_binding" >/dev/null
cat "$final_report"

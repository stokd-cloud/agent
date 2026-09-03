#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC1091
source /opt/stokd-agent/bin/host-common
[[ "$#" == 0 ]] || { echo 'validation seed accepts no arguments' >&2; exit 2; }
agent_load_config
[[ "$AGENT_STAGE" == source-val12 ]] || { echo 'the fixed validation seed is source-val12 only' >&2; exit 7; }
install -d -m 0700 /run/stokd-agent /run/stokd-agent/raw /var/lib/stokd-agent/receipts
agent_prepare_private_registry
agent_pull_image "$AGENT_MAINTENANCE_IMAGE"
instance_id="$(agent_verify_instance)"
agent_mount_volume
systemctl is-active --quiet stokd-agent-mongo.service || exit 7
exec 9>/run/stokd-agent/maintenance.lock
flock -n 9 || { echo 'another Agent maintenance operation owns the host' >&2; exit 7; }
agent_assert_no_active_restore || { echo 'validation seed refused while a restore is incomplete' >&2; exit 7; }
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  rm -f /run/stokd-agent/raw/{runtime,validation-payload}.secret \
    /run/stokd-agent/{validation-seed-config,validation-seed-credentials,validation-artifact-custody,aws-process}.json \
    /run/stokd-agent/aws-config
  exit "$status"
}
trap cleanup EXIT INT TERM
fixture="$(docker run --rm --network none --read-only --security-opt no-new-privileges --cap-drop ALL \
  -v /run/stokd-agent/raw:/run/stokd-agent/raw:rw \
  --entrypoint /usr/local/bin/node "$AGENT_MAINTENANCE_IMAGE" \
  /opt/stokd-agent/validation-payload.mjs /run/stokd-agent/raw/validation-payload.secret)"
IFS=$'\t' read -r operation_id expected_sha <<<"$fixture"
[[ "$operation_id" == valop_work12_durable_fixture && "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || exit 7
retained_key="agents/validation/$operation_id/retained.bin"
absent_key="agents/validation/$operation_id/absent-after-backup.bin"
durable_custody=/var/lib/stokd-agent/receipts/validation-artifact-custody-v1.json
if [[ -e "$durable_custody" ]]; then
  [[ -f "$durable_custody" && ! -L "$durable_custody" && "$(stat -c '%a:%u' "$durable_custody")" == '400:0' ]] || exit 7
  install -o 0 -g 0 -m 0400 "$durable_custody" /run/stokd-agent/validation-artifact-custody.json
else
  upload_custody() {
    local artifact_key="$1" version_id observed_version observed_etag observed_length observed_kms observed_sha observed_at
    version_id="$(agent_aws_with_runtime s3api put-object --region us-east-1 \
      --bucket "$AGENT_ARTIFACT_BUCKET" --key "$artifact_key" \
      --body /run/stokd-agent/raw/validation-payload.secret \
      --server-side-encryption aws:kms --ssekms-key-id "$AGENT_KMS_KEY_ARN" \
      --metadata "sha256=$expected_sha" --query VersionId --output text)"
    [[ "$version_id" =~ ^[A-Za-z0-9._=+/-]{1,1024}$ ]] || return 7
    head_field() { agent_aws s3api head-object --region us-east-1 --bucket "$AGENT_ARTIFACT_BUCKET" --key "$artifact_key" --version-id "$version_id" --query "$1" --output text; }
    observed_version="$(head_field VersionId)"
    observed_etag="$(head_field ETag | tr -d '"')"
    observed_length="$(head_field ContentLength)"
    observed_kms="$(head_field SSEKMSKeyId)"
    observed_sha="$(head_field Metadata.sha256)"
    observed_at="$(date -u -d "$(head_field LastModified)" +%Y-%m-%dT%H:%M:%S.000Z)"
    [[ "$observed_version" == "$version_id" && "$observed_length" == 32 && "$observed_kms" == "$AGENT_KMS_KEY_ARN" && "$observed_sha" == "$expected_sha" ]] || return 7
    [[ "$observed_etag" =~ ^[A-Fa-f0-9-]+$ ]] || return 7
    printf '{"bucket":"%s","objectKey":"%s","versionId":"%s","eTag":"%s","sha256":"%s","byteLength":32,"kmsKeyId":"%s","capturedAt":"%s"}' \
      "$AGENT_ARTIFACT_BUCKET" "$artifact_key" "$version_id" "$observed_etag" "$expected_sha" "$AGENT_KMS_KEY_ARN" "$observed_at"
  }
  retained_custody="$(upload_custody "$retained_key")"
  absent_custody="$(upload_custody "$absent_key")"
  custody="{\"schemaVersion\":\"1.0\",\"retained\":$retained_custody,\"absentAfterBackup\":$absent_custody}"
  printf '%s' "$custody" | agent_materialize_canonical_json /run/stokd-agent/validation-artifact-custody.json
  install -o 0 -g 0 -m 0400 /run/stokd-agent/validation-artifact-custody.json "$durable_custody"
fi
jq -e --arg retained "$retained_key" --arg absent "$absent_key" '
  keys == ["absentAfterBackup","retained","schemaVersion"] and .schemaVersion == "1.0" and
  .retained.objectKey == $retained and .absentAfterBackup.objectKey == $absent and
  .retained.versionId != .absentAfterBackup.versionId
' /run/stokd-agent/validation-artifact-custody.json >/dev/null
agent_fetch_secret "$AGENT_RUNTIME_SECRET_ARN" /run/stokd-agent/raw/runtime.secret
agent_materialize_credentials /run/stokd-agent/validation-seed-credentials.json runtimePassword /run/stokd-agent/raw/runtime.secret
resource_ids="{\"artifactBucket\":\"$AGENT_ARTIFACT_BUCKET\",\"backupBucket\":\"$AGENT_BACKUP_BUCKET\",\"databaseVolumeId\":\"$AGENT_VOLUME_ID\",\"kmsKeyArn\":\"$AGENT_KMS_KEY_ARN\",\"mongoInstanceId\":\"$instance_id\"}"
config="{\"schemaVersion\":\"1.0\",\"command\":\"validation-seed\",\"environment\":\"source-val12\",\"databaseName\":\"agent_source_val12\",\"replicaSet\":\"agent-rs\",\"mongoHost\":\"$AGENT_MONGO_HOST\",\"operationId\":\"$operation_id\",\"payloadPath\":\"/run/stokd-agent/raw/validation-payload.secret\",\"artifactCustodyPath\":\"/run/stokd-agent/validation-artifact-custody.json\",\"sourceResourceIds\":$resource_ids,\"region\":\"us-east-1\"}"
printf '%s' "$config" | agent_materialize_canonical_json /run/stokd-agent/validation-seed-config.json
output=/var/lib/stokd-agent/receipts/validation-seed-work12.json
agent_materialize_aws_credentials
agent_run_maintenance validation-seed /run/stokd-agent/validation-seed-config.json /run/stokd-agent/validation-seed-credentials.json "$output"
[[ "$(stat -c '%a:%u' "$output")" == '600:0' ]] || exit 7
cat "$output"

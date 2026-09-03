#!/usr/bin/env bash
set -euo pipefail

agent_load_config() {
  [[ "$(id -u)" == 0 ]] || { echo 'Agent host maintenance requires root' >&2; return 7; }
  [[ -f /etc/stokd-agent/host.env && "$(stat -c '%a:%u' /etc/stokd-agent/host.env)" == '400:0' ]] || {
    echo 'guarded Agent host config is missing' >&2
    return 7
  }
  # shellcheck disable=SC1091
  source /etc/stokd-agent/host.env
  [[ "$AGENT_AWS_ACCOUNT_ID" == '167217327520' && "$AWS_REGION" == 'us-east-1' ]] || return 7
  [[ "$AGENT_STAGE" == 'source-val12' || "$AGENT_STAGE" == 'restore-val12' ]] || return 7
  [[ "$AGENT_DATABASE_NAME" == "agent_${AGENT_STAGE//-/_}" ]] || return 7
  [[ "$AGENT_MONGO_HOST" == "mongo-${AGENT_STAGE}.sst:27017" ]] || return 7
  [[ "$AGENT_MONGO_IMAGE" =~ ^167217327520\.dkr\.ecr\.us-east-1\.amazonaws\.com/stokd-agent-runtime@sha256:[a-f0-9]{64}$ ]] || return 7
  [[ "$AGENT_MAINTENANCE_IMAGE" =~ ^167217327520\.dkr\.ecr\.us-east-1\.amazonaws\.com/stokd-agent-runtime@sha256:[a-f0-9]{64}$ ]] || return 7
  [[ "$AGENT_VOLUME_ID" =~ ^vol-[a-f0-9]{17}$ ]] || return 7
  [[ "$AGENT_KMS_KEY_ARN" =~ ^arn:aws:kms:us-east-1:167217327520:key/[a-f0-9-]{36}$ ]] || return 7
}

agent_imds() {
  local path="$1"
  local token
  token="$(curl --fail --silent --show-error --max-time 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)"
  curl --fail --silent --show-error --max-time 2 -H "X-aws-ec2-metadata-token: ${token}" "http://169.254.169.254/latest/${path}"
}

agent_prepare_private_registry() {
  command -v docker >/dev/null || { echo 'Docker is missing from the pinned ECS AMI' >&2; return 7; }
  command -v docker-credential-ecr-login >/dev/null || {
    echo 'the pinned ECS AMI is missing the ECR credential helper' >&2
    return 7
  }
  install -d -m 0700 /run/stokd-agent/docker
  printf '%s\n' '{"credsStore":"ecr-login"}' > /run/stokd-agent/docker/config.json
  chmod 0400 /run/stokd-agent/docker/config.json
}

# The host never installs or assumes a host AWS CLI.  The reviewed maintenance
# image is the only AWS client and may reach IMDS only for this short-lived,
# root-owned host helper invocation.
agent_aws() {
  [[ -n "${AGENT_MAINTENANCE_IMAGE:-}" ]] || return 7
  docker run --rm \
    --network host \
    --read-only \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m \
    -e AWS_REGION=us-east-1 \
    -e AWS_DEFAULT_REGION=us-east-1 \
    -e AWS_EC2_METADATA_DISABLED=false \
    --entrypoint /usr/local/bin/aws \
    "$AGENT_MAINTENANCE_IMAGE" "$@"
}

agent_aws_with_data_volume() {
  [[ -n "${AGENT_MAINTENANCE_IMAGE:-}" ]] || return 7
  docker run --rm \
    --network host \
    --read-only \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m \
    -v /var/lib/stokd-agent:/var/lib/stokd-agent:rw \
    -e AWS_REGION=us-east-1 \
    -e AWS_DEFAULT_REGION=us-east-1 \
    -e AWS_EC2_METADATA_DISABLED=false \
    --entrypoint /usr/local/bin/aws \
    "$AGENT_MAINTENANCE_IMAGE" "$@"
}

agent_aws_with_runtime() {
  [[ -n "${AGENT_MAINTENANCE_IMAGE:-}" ]] || return 7
  docker run --rm --network host --read-only --security-opt no-new-privileges --cap-drop ALL \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m \
    -v /run/stokd-agent:/run/stokd-agent:rw \
    -e AWS_REGION=us-east-1 -e AWS_DEFAULT_REGION=us-east-1 -e AWS_EC2_METADATA_DISABLED=false \
    --entrypoint /usr/local/bin/aws "$AGENT_MAINTENANCE_IMAGE" "$@"
}

agent_fetch_secret_version() {
  local arn="$1" version_id="$2" path="$3"
  [[ "$arn" =~ ^arn:aws:secretsmanager:us-east-1:167217327520:secret:stokd-agent-(source|restore)-val12-(runtime|migration|backup)-[A-Za-z0-9]{6}$ ]] || return 7
  [[ "$version_id" =~ ^[A-Za-z0-9-]{32,64}$ ]] || return 7
  [[ "$path" == /run/stokd-agent/raw/*.secret ]] || return 7
  umask 077
  rm -f "$path"
  agent_aws secretsmanager get-secret-value --region us-east-1 --secret-id "$arn" --version-id "$version_id" --query SecretString --output text > "$path"
  [[ "$(wc -c < "$path")" -ge 33 ]] || { rm -f "$path"; return 7; }
  chmod 0400 "$path"
}

agent_current_secret_version() {
  local arn="$1" version
  [[ "$arn" =~ ^arn:aws:secretsmanager:us-east-1:167217327520:secret:stokd-agent-(source|restore)-val12-(runtime|migration|backup)-[A-Za-z0-9]{6}$ ]] || return 7
  version="$(agent_aws secretsmanager list-secret-version-ids --region us-east-1 --secret-id "$arn" --include-deprecated --query "Versions[?contains(VersionStages, 'AWSCURRENT')].VersionId | [0]" --output text)"
  [[ "$version" =~ ^[A-Za-z0-9-]{32,64}$ ]] || return 7
  printf '%s\n' "$version"
}

agent_put_secret_version() {
  local arn="$1" version_id="$2" path="$3" observed
  [[ "$AGENT_STAGE" == restore-val12 ]] || return 7
  [[ "$arn" =~ ^arn:aws:secretsmanager:us-east-1:167217327520:secret:stokd-agent-restore-val12-(runtime|migration|backup)-[A-Za-z0-9]{6}$ ]] || return 7
  [[ "$version_id" =~ ^[a-f0-9]{64}$ ]] || return 7
  [[ "$path" == /run/stokd-agent/raw/*.secret && "$(stat -c '%a:%u' "$path")" == '400:0' ]] || return 7
  observed="$(agent_aws_with_runtime secretsmanager put-secret-value --region us-east-1 --secret-id "$arn" --client-request-token "$version_id" --secret-string "file://$path" --query VersionId --output text)"
  [[ "$observed" == "$version_id" ]] || { echo 'Secrets Manager returned a different planned VersionId' >&2; return 7; }
}

agent_restore_state() {
  local state_path="$1" operation_id="$2" input_binding="$3"
  shift 3
  [[ "$state_path" == "/var/lib/stokd-agent/receipts/restore-operation-${operation_id}.json" ]] || return 7
  docker run --rm --network none --read-only --security-opt no-new-privileges --cap-drop ALL \
    -v /var/lib/stokd-agent/receipts:/var/lib/stokd-agent/receipts:rw \
    --entrypoint /usr/local/bin/node "$AGENT_MAINTENANCE_IMAGE" \
    /opt/stokd-agent/restore-operation-state.mjs "$@" "$state_path" "$operation_id" "$input_binding"
}

agent_bind_active_restore() {
  local state_path="$1" operation_id="$2" input_binding="$3"
  [[ "$state_path" == "/var/lib/stokd-agent/receipts/restore-operation-${operation_id}.json" ]] || return 7
  docker run --rm --network none --read-only --security-opt no-new-privileges --cap-drop ALL \
    -v /var/lib/stokd-agent/receipts:/var/lib/stokd-agent/receipts:rw \
    --entrypoint /usr/local/bin/node "$AGENT_MAINTENANCE_IMAGE" \
    /opt/stokd-agent/restore-operation-state.mjs active-bind "$state_path" "$operation_id" "$input_binding"
}

agent_release_active_restore() {
  local state_path="$1" operation_id="$2" input_binding="$3"
  [[ "$state_path" == "/var/lib/stokd-agent/receipts/restore-operation-${operation_id}.json" ]] || return 7
  docker run --rm --network none --read-only --security-opt no-new-privileges --cap-drop ALL \
    -v /var/lib/stokd-agent/receipts:/var/lib/stokd-agent/receipts:rw \
    --entrypoint /usr/local/bin/node "$AGENT_MAINTENANCE_IMAGE" \
    /opt/stokd-agent/restore-operation-state.mjs active-release "$state_path" "$operation_id" "$input_binding"
}

agent_assert_no_active_restore() {
  docker run --rm --network none --read-only --security-opt no-new-privileges --cap-drop ALL \
    -v /var/lib/stokd-agent/receipts:/var/lib/stokd-agent/receipts:rw \
    --entrypoint /usr/local/bin/node "$AGENT_MAINTENANCE_IMAGE" \
    /opt/stokd-agent/restore-operation-state.mjs assert-no-active >/dev/null
}

agent_generate_restore_secret() {
  local operation_id="$1" output="$2"
  [[ "$output" == /run/stokd-agent/raw/*.secret ]] || return 7
  rm -f "$output"
  docker run --rm --network none --read-only --security-opt no-new-privileges --cap-drop ALL \
    -v /run/stokd-agent/raw:/run/stokd-agent/raw:rw \
    --entrypoint /usr/local/bin/node "$AGENT_MAINTENANCE_IMAGE" \
    /opt/stokd-agent/restore-secret-material.mjs generate "$operation_id" "$output"
  [[ "$(stat -c '%a:%u' "$output")" == '400:0' ]] || return 7
}

agent_derive_restore_material() {
  local operation_id="$1" runtime_secret="$2" hmac_output="$3" session_output="$4"
  for path in "$runtime_secret" "$hmac_output" "$session_output"; do [[ "$path" == /run/stokd-agent/raw/*.secret ]] || return 7; done
  rm -f "$hmac_output" "$session_output"
  docker run --rm --network none --read-only --security-opt no-new-privileges --cap-drop ALL \
    -v /run/stokd-agent/raw:/run/stokd-agent/raw:rw \
    --entrypoint /usr/local/bin/node "$AGENT_MAINTENANCE_IMAGE" \
    /opt/stokd-agent/restore-secret-material.mjs derive "$operation_id" "$runtime_secret" "$hmac_output" "$session_output"
  [[ "$(stat -c '%a:%u' "$hmac_output")" == '400:0' && "$(stat -c '%a:%u' "$session_output")" == '400:0' ]] || return 7
}

agent_verify_instance() {
  local instance_id observed_project observed_stage observed_volumes
  instance_id="$(agent_imds meta-data/instance-id)"
  [[ "$instance_id" =~ ^i-[a-f0-9]{17}$ ]] || return 7
  observed_project="$(agent_aws ec2 describe-instances --region us-east-1 --instance-ids "$instance_id" --query "Reservations[0].Instances[0].Tags[?Key=='Project']|[0].Value" --output text)"
  observed_stage="$(agent_aws ec2 describe-instances --region us-east-1 --instance-ids "$instance_id" --query "Reservations[0].Instances[0].Tags[?Key=='Stage']|[0].Value" --output text)"
  observed_volumes="$(agent_aws ec2 describe-instances --region us-east-1 --instance-ids "$instance_id" --query 'Reservations[0].Instances[0].BlockDeviceMappings[].Ebs.VolumeId' --output text)"
  [[ "$observed_project" == 'stokd-agent' && "$observed_stage" == "$AGENT_STAGE" ]] || {
    echo 'EC2 instance custody tags do not match the guarded host configuration' >&2
    return 7
  }
  tr '\t' '\n' <<<"$observed_volumes" | grep -Fxq "$AGENT_VOLUME_ID" || {
    echo 'retained data volume is not attached to this guarded instance' >&2
    return 7
  }
  printf '%s\n' "$instance_id"
}

agent_mount_volume() {
  mkdir -p /var/lib/stokd-agent
  local compact="${AGENT_VOLUME_ID//-/}"
  local device="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${compact}"
  for _ in $(seq 1 180); do [[ -b "$device" ]] && break; sleep 1; done
  [[ -b "$device" ]] || { echo 'retained Agent data volume did not attach' >&2; return 7; }
  local filesystem initialization_state
  initialization_state="$(agent_aws ec2 describe-volumes --region us-east-1 --volume-ids "$AGENT_VOLUME_ID" --query "Volumes[0].Tags[?Key=='InitializationState']|[0].Value" --output text)"
  [[ "$initialization_state" == pending-v1 || "$initialization_state" == initialized-v1 ]] || {
    echo 'retained data volume has no valid initialization proof' >&2
    return 7
  }
  filesystem="$(blkid -o value -s TYPE "$device" 2>/dev/null || true)"
  if [[ -z "$filesystem" ]]; then
    [[ "$initialization_state" == pending-v1 ]] || {
      echo 'refusing to format initialized retained media with unreadable filesystem metadata' >&2
      return 7
    }
    mkfs.xfs -L stokd-agent-data "$device"
    filesystem="$(blkid -o value -s TYPE "$device" 2>/dev/null || true)"
  fi
  [[ "$filesystem" == xfs ]] || { echo "unexpected retained volume filesystem ${filesystem}" >&2; return 7; }
  if [[ "$initialization_state" == pending-v1 ]]; then
    agent_aws ec2 create-tags --region us-east-1 --resources "$AGENT_VOLUME_ID" --tags Key=InitializationState,Value=initialized-v1
    initialization_state="$(agent_aws ec2 describe-volumes --region us-east-1 --volume-ids "$AGENT_VOLUME_ID" --query "Volumes[0].Tags[?Key=='InitializationState']|[0].Value" --output text)"
    [[ "$initialization_state" == initialized-v1 ]] || { echo 'fresh volume initialization proof did not finalize' >&2; return 7; }
  fi
  if ! mountpoint -q /var/lib/stokd-agent; then mount -o nodev,nosuid,noatime "$device" /var/lib/stokd-agent; fi
  local expected_device mounted_source mounted_device
  expected_device="$(readlink -f "$device")"
  mounted_source="$(findmnt -n -o SOURCE --target /var/lib/stokd-agent)"
  mounted_device="$(readlink -f "$mounted_source")"
  [[ -b "$expected_device" && -b "$mounted_device" && "$mounted_device" == "$expected_device" ]] || {
    echo 'retained data mount identity mismatch' >&2
    return 7
  }
  install -d -m 0700 /var/lib/stokd-agent/mongo /var/lib/stokd-agent/backups /var/lib/stokd-agent/receipts /var/lib/stokd-agent/restore
  chown -R 999:999 /var/lib/stokd-agent/mongo
}

agent_pull_image() {
  local image="$1"
  DOCKER_CONFIG=/run/stokd-agent/docker docker pull "$image" >/dev/null
  docker image inspect "$image" --format '{{json .RepoDigests}}' | grep -Fq "$image" || {
    echo 'private image digest verification failed' >&2
    return 7
  }
}

agent_fetch_secret() {
  local arn="$1"
  local path="$2"
  [[ "$arn" =~ ^arn:aws:secretsmanager:us-east-1:167217327520:secret:stokd-agent-(source|restore)-val12-(runtime|migration|backup)-[A-Za-z0-9]{6}$ ]] || return 7
  umask 077
  agent_aws secretsmanager get-secret-value --region us-east-1 --secret-id "$arn" --query SecretString --output text > "$path"
  [[ "$(wc -c < "$path")" -ge 33 ]] || { rm -f "$path"; return 7; }
  chmod 0400 "$path"
}

agent_materialize_canonical_json() {
  local output="$1"
  [[ "$output" == /run/stokd-agent/*.json ]] || return 7
  rm -f "$output"
  docker run --rm --interactive \
    --network none \
    --read-only \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    -v /run/stokd-agent:/run/stokd-agent:rw \
    --entrypoint /usr/local/bin/node \
    "$AGENT_MAINTENANCE_IMAGE" \
    /opt/stokd-agent/materialize-json.mjs canonical "$output"
  [[ "$(stat -c '%a:%u' "$output")" == '400:0' ]] || return 7
}

agent_materialize_credentials() {
  local output="$1"
  shift
  [[ "$output" == /run/stokd-agent/*.json ]] || return 7
  rm -f "$output"
  docker run --rm \
    --network none \
    --read-only \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    -v /run/stokd-agent:/run/stokd-agent:rw \
    --entrypoint /usr/local/bin/node \
    "$AGENT_MAINTENANCE_IMAGE" \
    /opt/stokd-agent/materialize-json.mjs credentials "$output" "$@"
  [[ "$(stat -c '%a:%u' "$output")" == '400:0' ]] || return 7
}

# Export one short-lived instance-role credential process document.  Networked
# maintenance containers receive this file explicitly and still cannot reach
# IMDS themselves through the bridge with hop-limit 1.
agent_materialize_aws_credentials() {
  local process_file=/run/stokd-agent/aws-process.json
  local config_file=/run/stokd-agent/aws-config
  umask 077
  agent_aws configure export-credentials --format process > "$process_file"
  chmod 0400 "$process_file"
  printf '%s\n' '[profile agent-host]' 'credential_process = cat /run/stokd-agent/aws-process.json' > "$config_file"
  chmod 0400 "$config_file"
}

agent_run_maintenance() {
  local command="$1"
  local config="$2"
  local credentials="$3"
  local output="$4"
  local hmac_file="${5:-}"
  [[ "$command" == backup || "$command" == restore-finalize || "$command" == readiness || "$command" == migrate || "$command" == validation-seed || "$command" == validation-read ]] || return 7
  [[ "$config" == /run/stokd-agent/*.json && "$credentials" == /run/stokd-agent/*.json ]] || return 7
  rm -f "$output"
  local hmac_args=()
  [[ -z "$hmac_file" ]] || hmac_args=(-e "AGENT_RECEIPT_HMAC_KEY_FILE=$hmac_file")
  docker run --rm \
    --network stokd-agent-mongo \
    --read-only \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=128m \
    -v /run/stokd-agent:/run/stokd-agent:rw \
    -v /var/lib/stokd-agent:/var/lib/stokd-agent:rw \
    -e AWS_REGION=us-east-1 \
    -e AWS_DEFAULT_REGION=us-east-1 \
    -e AWS_EC2_METADATA_DISABLED=true \
    -e AWS_SDK_LOAD_CONFIG=1 \
    -e AWS_PROFILE=agent-host \
    -e AWS_CONFIG_FILE=/run/stokd-agent/aws-config \
    -e "AGENT_MAINTENANCE_CONFIG=$config" \
    -e "AGENT_CREDENTIAL_FILE=$credentials" \
    -e "AGENT_OUTPUT_PATH=$output" \
    "${hmac_args[@]}" \
    "$AGENT_MAINTENANCE_IMAGE" "$command"
}

agent_assert_no_listener() {
  local port="$1"
  ! ss -H -ltn "sport = :${port}" | grep -q .
}

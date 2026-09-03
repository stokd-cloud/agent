#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC1091
source /opt/stokd-agent/bin/host-common
agent_load_config
install -d -m 0700 /run/stokd-agent
agent_prepare_private_registry
agent_pull_image "$AGENT_MAINTENANCE_IMAGE"
instance_verified=false
for _ in $(seq 1 180); do
  if agent_verify_instance >/dev/null; then instance_verified=true; break; fi
  sleep 2
done
[[ "$instance_verified" == true ]] || { echo 'owned data volume did not attach before Mongo startup' >&2; exit 7; }
agent_mount_volume
agent_pull_image "$AGENT_MONGO_IMAGE"

install -d -m 0700 /run/stokd-agent/credentials
credential_args=()
if [[ ! -f /var/lib/stokd-agent/mongo/.agent-initialized-v2 ]]; then
  agent_fetch_secret "$AGENT_RUNTIME_SECRET_ARN" /run/stokd-agent/credentials/runtime.secret
  agent_fetch_secret "$AGENT_MIGRATION_SECRET_ARN" /run/stokd-agent/credentials/migration.secret
  agent_fetch_secret "$AGENT_BACKUP_SECRET_ARN" /run/stokd-agent/credentials/backup.secret
  credential_args=(
    -e MONGO_RUNTIME_CREDENTIAL_FILE=/run/stokd-agent/credentials/runtime.secret
    -e MONGO_MIGRATION_CREDENTIAL_FILE=/run/stokd-agent/credentials/migration.secret
    -e MONGO_BACKUP_CREDENTIAL_FILE=/run/stokd-agent/credentials/backup.secret
  )
fi

cleanup() {
  rm -f /run/stokd-agent/credentials/*.secret
  if [[ -s /run/stokd-agent/mongo.cid ]]; then
    local cid
    cid="$(cat /run/stokd-agent/mongo.cid)"
    if [[ "$cid" =~ ^[a-f0-9]{64}$ ]] && [[ "$(docker inspect --format '{{index .Config.Labels "io.stokd.agent.stage"}}' "$cid" 2>/dev/null || true)" == "$AGENT_STAGE" ]]; then
      docker stop --time 30 "$cid" >/dev/null 2>&1 || true
      docker rm -f "$cid" >/dev/null 2>&1 || true
    fi
  fi
  rm -f /run/stokd-agent/mongo.cid
}
trap cleanup EXIT INT TERM
exec 9>/run/stokd-agent/mongo.lock
flock -n 9 || { echo 'Agent Mongo custody lock is already held' >&2; exit 7; }
if docker network inspect stokd-agent-mongo >/dev/null 2>&1; then
  network_custody="$(docker network inspect --format '{{.Driver}} {{index .Options "com.docker.network.bridge.enable_icc"}} {{index .Labels "io.stokd.agent.custody"}} {{.Scope}}' stokd-agent-mongo)"
  [[ "$network_custody" == 'bridge false mongo local' ]] || {
    echo 'preexisting Mongo bridge failed custody validation' >&2
    exit 7
  }
else
  docker network create \
    --driver bridge \
    --opt com.docker.network.bridge.enable_icc=false \
    --label io.stokd.agent.custody=mongo \
    stokd-agent-mongo >/dev/null
fi

# IMDSv2 hop-limit 1 plus this bridge must make the instance role unreachable
# from the steady database container before any credentials are mounted.
if timeout 3 docker run --rm --network stokd-agent-mongo --entrypoint bash "$AGENT_MONGO_IMAGE" \
  -ec 'exec 3<>/dev/tcp/169.254.169.254/80; printf "GET /latest/meta-data/iam/security-credentials/ HTTP/1.0\r\n\r\n" >&3; read -r -t 1 _ <&3'; then
  echo 'steady Mongo container unexpectedly reached EC2 instance metadata' >&2
  exit 7
fi

rm -f /run/stokd-agent/mongo.cid
docker run --detach --name stokd-agent-mongo \
  --cidfile /run/stokd-agent/mongo.cid \
  --label "io.stokd.agent.stage=$AGENT_STAGE" \
  --network stokd-agent-mongo \
  --publish 27017:27017 \
  --read-only \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETGID --cap-add SETUID \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
  -v /var/lib/stokd-agent/mongo:/data/db:rw \
  -v /run/stokd-agent:/run/stokd-agent:rw \
  -e AGENT_MONGO_RUNTIME_DIR=/run/stokd-agent \
  -e MONGO_DATABASE="$AGENT_DATABASE_NAME" \
  -e MONGO_REPLICA_SET=agent-rs \
  -e MONGO_REPLICA_HOST="$AGENT_MONGO_HOST" \
  "${credential_args[@]}" \
  "$AGENT_MONGO_IMAGE" >/dev/null
cid="$(cat /run/stokd-agent/mongo.cid)"
[[ "$cid" =~ ^[a-f0-9]{64}$ ]] || { echo 'Mongo container custody ID is invalid' >&2; exit 7; }
set +e
docker wait "$cid" >/dev/null
status="$(docker inspect --format '{{.State.ExitCode}}' "$cid" 2>/dev/null || printf 7)"
set -e
[[ "$status" =~ ^[0-9]+$ ]] || status=7
exit "$status"

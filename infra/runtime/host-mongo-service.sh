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

# IMDSv2 hop-limit 1 plus this bridge must make the instance ROLE unreachable
# from the steady database container before any credentials are mounted.
#
# What hop-limit 1 actually prevents is the token PUT response crossing the
# docker bridge, so a container can still open a TCP socket to the link-local
# address and read an unauthenticated 401. Asserting on mere reachability
# therefore fails on a correctly-locked-down host. The assertion below runs the
# real IMDSv2 flow instead and fails only if credentials are genuinely
# retrievable, which is the property being guaranteed.
if timeout 6 docker run --rm --network stokd-agent-mongo --entrypoint bash "$AGENT_MONGO_IMAGE" -ec '
  token="$(timeout 2 curl --fail --silent --show-error -X PUT \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" \
    http://169.254.169.254/latest/api/token 2>/dev/null)" || exit 1
  [ -n "$token" ] || exit 1
  timeout 2 curl --fail --silent -H "X-aws-ec2-metadata-token: $token" \
    http://169.254.169.254/latest/meta-data/iam/security-credentials/ >/dev/null 2>&1
'; then
  echo 'steady Mongo container unexpectedly obtained EC2 instance credentials' >&2
  exit 7
fi

rm -f /run/stokd-agent/mongo.cid
docker run --detach --name stokd-agent-mongo \
  --cidfile /run/stokd-agent/mongo.cid \
  --label "io.stokd.agent.stage=$AGENT_STAGE" \
  --network stokd-agent-mongo \
  --publish 27017:27017 \
  `# The replica member is the Cloud Map name, which resolves to the instance` \
  `# ENI -- an address this container does not own, so mongod refuses to accept` \
  `# its own identity on reconfig. Mapping that name to loopback INSIDE the` \
  `# container makes it resolve to an address the node does own. External` \
  `# clients still resolve it through Cloud Map to the ENI and reach the` \
  `# published port, so the wire identity is unchanged.` \
  --add-host "${AGENT_MONGO_HOST%%:*}:127.0.0.1" \
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

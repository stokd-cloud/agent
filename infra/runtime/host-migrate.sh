#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC1091
source /opt/stokd-agent/bin/host-common

declare -A supplied=()
while (($#)); do
  case "$1" in
    --operation-id|--target-stage)
      [[ -z "${supplied[$1]:-}" && -n "${2:-}" ]] || { echo "duplicate or missing migration argument $1" >&2; exit 2; }
      supplied[$1]="$2"; shift 2 ;;
    *) echo "unrecognized migration argument $1" >&2; exit 2 ;;
  esac
done
operation_id="${supplied[--operation-id]:-}"
target_stage="${supplied[--target-stage]:-}"
[[ "$operation_id" =~ ^[a-z0-9][a-z0-9-]{2,80}$ ]] || exit 2
[[ "$target_stage" == source-val12 || "$target_stage" == restore-val12 ]] || exit 2

agent_load_config
[[ "$AGENT_STAGE" == "$target_stage" ]] || exit 7
install -d -m 0700 /run/stokd-agent /run/stokd-agent/raw /var/lib/stokd-agent/receipts
agent_prepare_private_registry
agent_pull_image "$AGENT_MAINTENANCE_IMAGE"
instance_verified=false
for _ in $(seq 1 180); do
  if agent_verify_instance >/dev/null; then instance_verified=true; break; fi
  sleep 2
done
[[ "$instance_verified" == true ]] || { echo 'owned data volume did not attach before migration' >&2; exit 7; }
agent_mount_volume
systemctl is-active --quiet stokd-agent-mongo.service || exit 7
mongo_ready=false
for _ in $(seq 1 180); do
  if ! agent_assert_no_listener 27017; then mongo_ready=true; break; fi
  sleep 1
done
[[ "$mongo_ready" == true ]] || { echo 'MongoDB did not become ready for guarded migration' >&2; exit 7; }
exec 9>/run/stokd-agent/maintenance.lock
flock -n 9 || { echo 'another Agent maintenance operation owns the host' >&2; exit 7; }
agent_assert_no_active_restore || { echo 'migration refused while a restore is incomplete' >&2; exit 7; }

api_owned=false
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  rm -f /run/stokd-agent/raw/migration.secret /run/stokd-agent/{migrate-config,migrate-credentials,aws-process}.json /run/stokd-agent/aws-config
  if [[ "$api_owned" == true ]]; then
    agent_aws ecs update-service --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --service "$AGENT_API_SERVICE_ARN" --desired-count 1 >/dev/null || status=7
    agent_aws ecs wait services-stable --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --services "$AGENT_API_SERVICE_ARN" || status=7
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

service_state="$(agent_aws ecs describe-services --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --services "$AGENT_API_SERVICE_ARN" --query '[length(services), services[0].desiredCount, services[0].runningCount]' --output text)"
if [[ "$service_state" == $'1\t1\t1' ]]; then
  agent_aws ecs update-service --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --service "$AGENT_API_SERVICE_ARN" --desired-count 0 >/dev/null
  api_owned=true
  agent_aws ecs wait services-stable --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --services "$AGENT_API_SERVICE_ARN"
  [[ "$(agent_aws ecs describe-services --region us-east-1 --cluster "$AGENT_API_CLUSTER_ARN" --services "$AGENT_API_SERVICE_ARN" --query 'services[0].[desiredCount,runningCount]' --output text)" == $'0\t0' ]] || exit 7
elif [[ "$service_state" != 0$'\t'* && "$service_state" != $'1\t0\t0' ]]; then
  echo 'migration requires an absent, exact 1/1, or already-quiesced API service' >&2
  exit 7
fi

agent_fetch_secret "$AGENT_MIGRATION_SECRET_ARN" /run/stokd-agent/raw/migration.secret
agent_materialize_credentials /run/stokd-agent/migrate-credentials.json migrationPassword /run/stokd-agent/raw/migration.secret
config="{\"schemaVersion\":\"1.0\",\"command\":\"migrate\",\"environment\":\"$AGENT_STAGE\",\"databaseName\":\"$AGENT_DATABASE_NAME\",\"replicaSet\":\"agent-rs\",\"mongoHost\":\"$AGENT_MONGO_HOST\"}"
printf '%s' "$config" | agent_materialize_canonical_json /run/stokd-agent/migrate-config.json
output="/var/lib/stokd-agent/receipts/migrate-$operation_id.json"
agent_run_maintenance migrate /run/stokd-agent/migrate-config.json /run/stokd-agent/migrate-credentials.json "$output"
[[ "$(stat -c '%a:%u' "$output")" == '600:0' ]] || exit 7
cat "$output"

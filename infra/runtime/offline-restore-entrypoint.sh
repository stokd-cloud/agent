#!/usr/bin/env bash
set -euo pipefail
: "${AGENT_OFFLINE_BASE_CONFIG:?AGENT_OFFLINE_BASE_CONFIG is required}"
: "${AGENT_CREDENTIAL_FILE:?AGENT_CREDENTIAL_FILE is required}"
: "${AGENT_RECEIPT_HMAC_KEY_FILE:?AGENT_RECEIPT_HMAC_KEY_FILE is required}"
: "${AGENT_OUTPUT_PATH:?AGENT_OUTPUT_PATH is required}"
: "${AGENT_DBPATH_IDENTITY:?AGENT_DBPATH_IDENTITY is required}"
[[ "$AGENT_OFFLINE_BASE_CONFIG" == /run/stokd-agent/*.json ]] || exit 7
[[ "$AGENT_CREDENTIAL_FILE" == /run/stokd-agent/*.json ]] || exit 7
[[ "$AGENT_RECEIPT_HMAC_KEY_FILE" == /run/stokd-agent/* ]] || exit 7
[[ "$AGENT_OUTPUT_PATH" == /var/lib/stokd-agent/receipts/*.json ]] || exit 7
[[ "$AGENT_DBPATH_IDENTITY" =~ ^vol-[a-f0-9]{17}$ ]] || exit 7
for guarded in "$AGENT_OFFLINE_BASE_CONFIG" "$AGENT_CREDENTIAL_FILE" "$AGENT_RECEIPT_HMAC_KEY_FILE"; do
  [[ -f "$guarded" && "$(stat -c '%a:%u' "$guarded")" == '400:0' ]] || exit 7
done

port="$((20000 + RANDOM % 20000))"
[[ "$port" != 27017 ]] || port=27018
pid_file=/run/stokd-agent/offline-mongod.pid
config=/run/stokd-agent/restore-offline-config.json
log=/run/stokd-agent/offline-mongod.log
rm -f "$pid_file" "$config" "$log"

process_identity() { [[ -r "/proc/$1/stat" ]] && awk '{print $22}' "/proc/$1/stat"; }
verify_owned() {
  local pid="$1" identity="$2"
  [[ "$(process_identity "$pid" 2>/dev/null || true)" == "$identity" ]] || return 1
  local command_line
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command_line" == *mongod* && "$command_line" == *'--dbpath /var/lib/stokd-agent/mongo'* && "$command_line" == *"--port $port"* ]]
}
stop_owned() {
  [[ -s "$pid_file" ]] || return 0
  local pid identity
  pid="$(cat "$pid_file")"
  identity="${owned_identity:-}"
  kill -0 "$pid" 2>/dev/null || return 0
  verify_owned "$pid" "$identity" || { echo 'refusing to signal unowned offline mongod' >&2; return 7; }
  kill -TERM "$pid"
  for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || { wait "$pid" 2>/dev/null || true; return 0; }; verify_owned "$pid" "$identity" || return 7; sleep 1; done
  verify_owned "$pid" "$identity" || return 7
  kill -KILL "$pid"
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || { wait "$pid" 2>/dev/null || true; return 0; }; sleep 1; done
  echo 'offline mongod survived exact owned cleanup' >&2
  return 7
}
cleanup() { local status=$?; trap - EXIT INT TERM; stop_owned || status=7; exit "$status"; }
trap cleanup EXIT INT TERM

gosu mongodb mongod \
  --dbpath /var/lib/stokd-agent/mongo \
  --bind_ip 127.0.0.1 \
  --port "$port" \
  --pidfilepath "$pid_file" \
  --fork \
  --logpath "$log"
pid="$(cat "$pid_file")"
owned_identity="$(process_identity "$pid")"
[[ "$owned_identity" =~ ^[0-9]+$ ]] || exit 7
for _ in $(seq 1 120); do mongosh --quiet "mongodb://127.0.0.1:${port}/admin?directConnection=true" --eval 'quit(db.runCommand({ping:1}).ok?0:7)' >/dev/null 2>&1 && break; sleep 1; done
mongosh --quiet "mongodb://127.0.0.1:${port}/admin?directConnection=true" --eval 'quit(db.runCommand({ping:1}).ok?0:7)' >/dev/null
node /opt/stokd-agent/offline-config.mjs "$AGENT_OFFLINE_BASE_CONFIG" "$config" "$port" "$pid" "$owned_identity" "$AGENT_DBPATH_IDENTITY"
export AGENT_MAINTENANCE_CONFIG="$config"
/usr/local/bin/stokd-agent-storage-maintenance restore-offline
stop_owned
rm -f "$pid_file"
trap - EXIT INT TERM

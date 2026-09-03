#!/usr/bin/env bash
set -euo pipefail

: "${MONGO_DATABASE:?MONGO_DATABASE is required}"
: "${MONGO_REPLICA_HOST:?MONGO_REPLICA_HOST is required}"

[[ "$MONGO_DATABASE" =~ ^agent_(source|restore)_val12$ ]] || { echo 'invalid Agent validation database' >&2; exit 7; }
[[ "$MONGO_REPLICA_HOST" =~ ^mongo-(source-val12|restore-val12)\.sst:27017$ ]] || { echo 'invalid stable MongoDB member identity' >&2; exit 7; }
replica_set="${MONGO_REPLICA_SET:-agent-rs}"
[[ "$replica_set" == 'agent-rs' ]] || { echo 'invalid Agent replica-set name' >&2; exit 7; }

initialization_port="${MONGO_INITIALIZATION_PORT:-$((20000 + RANDOM % 20000))}"
[[ "$initialization_port" =~ ^[0-9]+$ ]] && (( initialization_port >= 1024 && initialization_port <= 65535 && initialization_port != 27017 )) || {
  echo 'initialization port must be a non-27017 high port' >&2
  exit 7
}
wait_attempts="${AGENT_MONGO_WAIT_ATTEMPTS:-120}"
[[ "$wait_attempts" =~ ^[0-9]+$ ]] && (( wait_attempts >= 1 && wait_attempts <= 120 )) || {
  echo 'AGENT_MONGO_WAIT_ATTEMPTS must be between 1 and 120' >&2
  exit 7
}
MONGO_REPLICA_SET="$replica_set"
MONGO_INITIALIZATION_PORT="$initialization_port"
export MONGO_DATABASE MONGO_REPLICA_HOST MONGO_REPLICA_SET MONGO_INITIALIZATION_PORT

data_dir="${MONGO_DATA_DIR:-/data/db}"
key_file="${data_dir}/.agent-replica-key"
initialized="${data_dir}/.agent-initialized-v2"
runtime_dir="${AGENT_MONGO_RUNTIME_DIR:-/tmp/agent-mongo-runtime}"
[[ "$runtime_dir" == /* ]] || { echo 'AGENT_MONGO_RUNTIME_DIR must be absolute' >&2; exit 7; }
script_dir="${runtime_dir}/initialization-js"
mkdir -p "$data_dir" "$script_dir"
chmod 0700 "$runtime_dir" "$script_dir"
chown -R mongodb:mongodb "$data_dir"
# mongod runs as mongodb via gosu and writes its pid and --logpath files
# directly into the runtime directory. The host creates that directory
# root-owned, so without this the forked child dies before it can log anything
# and the only symptom is "child process failed, exited with 1".
chown mongodb:mongodb "$runtime_dir" "$script_dir"
if [[ ! -s "$key_file" ]]; then
  umask 077
  openssl rand -base64 756 > "$key_file"
  chown mongodb:mongodb "$key_file"
fi
chmod 0400 "$key_file"

# These scripts contain no credentials. First initialization reads one guarded
# tmpfs credential file; no password enters argv, a URI, or the environment.
umask 077
cat > "$script_dir/standalone-ready.js" <<'MONGOJS'
const admin = connect(`mongodb://127.0.0.1:${process.env.MONGO_INITIALIZATION_PORT}/admin?directConnection=true`)
if (!admin.runCommand({ ping: 1 }).ok) throw new Error('standalone initialization endpoint is not ready')
MONGOJS
cat > "$script_dir/repl-ready.js" <<'MONGOJS'
const admin = connect('mongodb://127.0.0.1:27017/admin?directConnection=true')
if (admin.runCommand({ hello: 1 }).isWritablePrimary !== true) throw new Error('initialization replica is not primary')
MONGOJS
cat > "$script_dir/repl-ping.js" <<'MONGOJS'
const admin = connect('mongodb://127.0.0.1:27017/admin?directConnection=true')
if (!admin.runCommand({ ping: 1 }).ok) throw new Error('initialization replica endpoint is not ready')
MONGOJS
cat > "$script_dir/ensure-steady-principals.js" <<'MONGOJS'
const databaseName = process.env.MONGO_DATABASE
const admin = connect(`mongodb://127.0.0.1:${process.env.MONGO_INITIALIZATION_PORT}/admin?directConnection=true`)
const runtime = admin.getSiblingDB(databaseName)
const fs = require('fs')
const credential = {
  runtimePassword: fs.readFileSync(process.env.MONGO_RUNTIME_CREDENTIAL_FILE, 'utf8').trim(),
  migrationPassword: fs.readFileSync(process.env.MONGO_MIGRATION_CREDENTIAL_FILE, 'utf8').trim(),
  backupPassword: fs.readFileSync(process.env.MONGO_BACKUP_CREDENTIAL_FILE, 'utf8').trim(),
}
const expectedCredentialKeys = ['backupPassword', 'migrationPassword', 'runtimePassword']
if (expectedCredentialKeys.some(key => credential[key].length < 32)) throw new Error('initialization credentials must contain three strong passwords')
if (new Set(expectedCredentialKeys.map(key => credential[key])).size !== expectedCredentialKeys.length) throw new Error('steady-state passwords must be distinct')

function ensureRole(role, privileges, roles) {
  const current = admin.runCommand({ rolesInfo: { role, db: 'admin' } })
  const command = current.roles?.length ? { updateRole: role, privileges, roles } : { createRole: role, privileges, roles }
  const result = admin.runCommand(command)
  if (!result.ok) throw new Error(`unable to ensure role ${role}: ${tojson(result)}`)
}
function ensureUser(database, user, password, roles) {
  const current = database.runCommand({ usersInfo: { user, db: database.getName() } })
  const command = current.users?.length ? { updateUser: user, pwd: password, roles } : { createUser: user, pwd: password, roles }
  const result = database.runCommand(command)
  if (!result.ok) throw new Error(`unable to ensure user ${user}: ${tojson(result)}`)
}

const migrationRole = `agentMigration_${databaseName}`
ensureRole(migrationRole, [{ resource: { cluster: true }, actions: ['getParameter'] }], [
  { role: 'readWrite', db: databaseName },
  { role: 'dbAdmin', db: databaseName },
])
ensureUser(runtime, 'agent_runtime', credential.runtimePassword, [{ role: 'readWrite', db: databaseName }])
ensureUser(admin, 'agent_migration', credential.migrationPassword, [{ role: migrationRole, db: 'admin' }])
ensureUser(admin, 'agent_backup', credential.backupPassword, [
  { role: 'backup', db: 'admin' },
  { role: 'clusterMonitor', db: 'admin' },
])

const fcv = admin.runCommand({ setFeatureCompatibilityVersion: '7.0', confirm: true })
if (!fcv.ok) throw new Error(`unable to set FCV 7.0: ${tojson(fcv)}`)
const observedFcv = admin.runCommand({ getParameter: 1, featureCompatibilityVersion: 1 }).featureCompatibilityVersion?.version
if (observedFcv !== '7.0') throw new Error(`unexpected FCV ${observedFcv}`)
const build = admin.runCommand({ buildInfo: 1 })
if (build.version !== '7.0.29') throw new Error(`unexpected MongoDB version ${build.version}`)

const adminAgentUsers = (admin.runCommand({ usersInfo: 1 }).users ?? []).filter(user => user.user.startsWith('agent_')).map(user => user.user).sort()
const runtimeAgentUsers = (runtime.runCommand({ usersInfo: 1 }).users ?? []).filter(user => user.user.startsWith('agent_')).map(user => user.user).sort()
if (tojson(adminAgentUsers) !== tojson(['agent_backup', 'agent_migration']) || tojson(runtimeAgentUsers) !== tojson(['agent_runtime'])) {
  throw new Error(`unexpected Agent steady-state principals: ${tojson({ adminAgentUsers, runtimeAgentUsers })}`)
}
MONGOJS
cat > "$script_dir/replica-state.js" <<'MONGOJS'
const local = connect(`mongodb://127.0.0.1:${process.env.MONGO_INITIALIZATION_PORT}/local?directConnection=true`)
const config = local.getCollection('system.replset').findOne()
if (!config) print('none')
else if (config._id !== process.env.MONGO_REPLICA_SET || config.members?.length !== 1) print('invalid')
else if (config.members[0].host === process.env.MONGO_REPLICA_HOST) print('stable')
else if (config.members[0].host === '127.0.0.1:27017') print('loopback')
else print('invalid')
MONGOJS
cat > "$script_dir/init-or-promote-replica.js" <<'MONGOJS'
const admin = connect('mongodb://127.0.0.1:27017/admin?directConnection=true')
const status = admin.runCommand({ replSetGetStatus: 1 })
if (!status.ok) {
  if (status.codeName !== 'NotYetInitialized') throw new Error(`unable to inspect replica set: ${tojson(status)}`)
  const initiated = admin.runCommand({ replSetInitiate: { _id: process.env.MONGO_REPLICA_SET, members: [{ _id: 0, host: '127.0.0.1:27017' }] } })
  if (!initiated.ok) throw new Error(`unable to initiate replica set: ${tojson(initiated)}`)
}
MONGOJS
cat > "$script_dir/promote-stable-host.js" <<'MONGOJS'
const admin = connect('mongodb://127.0.0.1:27017/admin?directConnection=true')
const current = admin.runCommand({ replSetGetConfig: 1 })
if (!current.ok || current.config?._id !== process.env.MONGO_REPLICA_SET || current.config?.members?.length !== 1 || current.config.members[0]?.host !== '127.0.0.1:27017') {
  throw new Error(`unexpected loopback replica configuration: ${tojson(current)}`)
}
current.config.version += 1
current.config.members[0].host = process.env.MONGO_REPLICA_HOST
const changed = admin.runCommand({ replSetReconfig: current.config })
if (!changed.ok) throw new Error(`unable to set stable replica identity: ${tojson(changed)}`)
MONGOJS

mongo_script() {
  mongosh --quiet --nodb --file "$1"
}

wait_for_script() {
  local script="$1"
  local description="$2"
  for _ in $(seq 1 "$wait_attempts"); do
    mongo_script "$script" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "MongoDB did not become ${description} within ${wait_attempts} seconds" >&2
  return 1
}

owned_pid_file=''
owned_start_identity=''
owned_listener_port=''
credential_files=()

process_start_identity() {
  local pid="$1"
  [[ -r "/proc/${pid}/stat" ]] || return 1
  awk '{print $22}' "/proc/${pid}/stat"
}

verify_owned_mongod() {
  local pid="$1"
  local expected_start_identity="$2"
  [[ "$(process_start_identity "$pid" 2>/dev/null || true)" == "$expected_start_identity" ]] || return 1
  local command_line
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command_line" == *mongod* && "$command_line" == *"--dbpath $data_dir"* ]]
}

owned_process_is_running() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null || return 1
  local state
  state="$(ps -p "$pid" -o stat= 2>/dev/null || true)"
  if [[ "$state" == Z* ]]; then
    wait "$pid" 2>/dev/null || true
    return 1
  fi
  return 0
}

stop_owned_mongod() {
  local pid_file="$1"
  local expected_start_identity="$2"
  local listener_port="$3"
  [[ -f "$pid_file" ]] || return 0
  local pid
  pid="$(cat "$pid_file")"
  [[ "$pid" =~ ^[0-9]+$ ]] || { echo "invalid owned process id in ${pid_file}" >&2; return 1; }
  owned_process_is_running "$pid" || return 0
  verify_owned_mongod "$pid" "$expected_start_identity" || {
    echo "refusing to signal unowned process ${pid}" >&2
    return 1
  }
  kill -TERM "$pid"
  for _ in $(seq 1 "$wait_attempts"); do
    if ! owned_process_is_running "$pid"; then
      wait "$pid" 2>/dev/null || true
      return 0
    fi
    verify_owned_mongod "$pid" "$expected_start_identity" || {
      echo "owned initialization process ${pid} changed identity after TERM" >&2
      return 1
    }
    sleep 1
  done
  verify_owned_mongod "$pid" "$expected_start_identity" || {
    echo "refusing to KILL initialization process ${pid} after its identity changed" >&2
    return 1
  }
  kill -KILL "$pid"
  for _ in $(seq 1 "$wait_attempts"); do
    if ! owned_process_is_running "$pid"; then
      wait "$pid" 2>/dev/null || true
      break
    fi
    verify_owned_mongod "$pid" "$expected_start_identity" || {
      echo "initialization process ${pid} changed identity after KILL" >&2
      return 1
    }
    sleep 1
  done
  if owned_process_is_running "$pid"; then
    echo "owned initialization mongod ${pid} survived KILL" >&2
    return 1
  fi
  if command -v ss >/dev/null && ss -H -ltn "sport = :${listener_port}" | grep -q .; then
    echo "initialization listener on ${listener_port} survived owned process cleanup" >&2
    return 1
  fi
}

cleanup_owned_mongod() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [[ -n "$owned_pid_file" ]]; then
    if ! stop_owned_mongod "$owned_pid_file" "$owned_start_identity" "$owned_listener_port"; then
      exit_code=7
    fi
  fi
  ((${#credential_files[@]} == 0)) || rm -f "${credential_files[@]}" || true
  exit "$exit_code"
}
trap cleanup_owned_mongod EXIT INT TERM

if [[ ! -f "$initialized" ]]; then
  : "${MONGO_RUNTIME_CREDENTIAL_FILE:?MONGO_RUNTIME_CREDENTIAL_FILE is required for first initialization}"
  : "${MONGO_MIGRATION_CREDENTIAL_FILE:?MONGO_MIGRATION_CREDENTIAL_FILE is required for first initialization}"
  : "${MONGO_BACKUP_CREDENTIAL_FILE:?MONGO_BACKUP_CREDENTIAL_FILE is required for first initialization}"
  credential_files=("$MONGO_RUNTIME_CREDENTIAL_FILE" "$MONGO_MIGRATION_CREDENTIAL_FILE" "$MONGO_BACKUP_CREDENTIAL_FILE")
  for credential_file in "${credential_files[@]}"; do
    [[ "$credential_file" == "${runtime_dir}/credentials/"*.secret && -f "$credential_file" ]] || {
      echo 'initialization credentials must be guarded runtime .secret files' >&2
      exit 7
    }
    [[ "$(stat -c '%a:%u' "$credential_file")" == '400:0' ]] || {
      echo 'initialization credential files must be mode 0400 and owned by root' >&2
      exit 7
    }
  done
  export MONGO_RUNTIME_CREDENTIAL_FILE MONGO_MIGRATION_CREDENTIAL_FILE MONGO_BACKUP_CREDENTIAL_FILE
  standalone_pid_file="${runtime_dir}/standalone.pid"
  rm -f "$standalone_pid_file"
  owned_pid_file="$standalone_pid_file"
  gosu mongodb mongod \
    --dbpath "$data_dir" \
    --bind_ip 127.0.0.1 \
    --port "$initialization_port" \
    --pidfilepath "$standalone_pid_file" \
    --fork \
    --logpath "${runtime_dir}/standalone.log"
  owned_start_identity="$(process_start_identity "$(cat "$standalone_pid_file")")"
  owned_listener_port="$initialization_port"
  wait_for_script "$script_dir/standalone-ready.js" 'a loopback-only standalone initializer'
  mongo_script "$script_dir/ensure-steady-principals.js"
  replica_state="$(mongo_script "$script_dir/replica-state.js" | tail -n 1)"
  [[ "$replica_state" == 'none' || "$replica_state" == 'loopback' || "$replica_state" == 'stable' ]] || {
    echo "invalid retained replica configuration: ${replica_state}" >&2
    exit 7
  }
  stop_owned_mongod "$standalone_pid_file" "$owned_start_identity" "$owned_listener_port"
  owned_pid_file=''
  owned_start_identity=''
  owned_listener_port=''

  if [[ "$replica_state" != 'stable' ]]; then
    replica_pid_file="${runtime_dir}/replica-init.pid"
    rm -f "$replica_pid_file"
    owned_pid_file="$replica_pid_file"
    gosu mongodb mongod \
      --dbpath "$data_dir" \
      --replSet "$replica_set" \
      --bind_ip 127.0.0.1 \
      --port 27017 \
      --pidfilepath "$replica_pid_file" \
      --fork \
      --logpath "${runtime_dir}/replica-init.log"
    owned_start_identity="$(process_start_identity "$(cat "$replica_pid_file")")"
    owned_listener_port=27017
    wait_for_script "$script_dir/repl-ping.js" 'a loopback-only replica initializer'
    mongo_script "$script_dir/init-or-promote-replica.js"
    wait_for_script "$script_dir/repl-ready.js" 'a loopback-only writable initialization replica'
    mongo_script "$script_dir/promote-stable-host.js"
    stop_owned_mongod "$replica_pid_file" "$owned_start_identity" "$owned_listener_port"
    owned_pid_file=''
    owned_start_identity=''
    owned_listener_port=''
  fi

  rm -f "${credential_files[@]}"
  credential_files=()
  unset MONGO_RUNTIME_CREDENTIAL_FILE MONGO_MIGRATION_CREDENTIAL_FILE MONGO_BACKUP_CREDENTIAL_FILE
  touch "$initialized"
  chown mongodb:mongodb "$initialized"
fi

unset MONGO_RUNTIME_CREDENTIAL_FILE MONGO_MIGRATION_CREDENTIAL_FILE MONGO_BACKUP_CREDENTIAL_FILE
trap - EXIT INT TERM
exec gosu mongodb mongod \
  --dbpath "$data_dir" \
  --replSet "$replica_set" \
  --bind_ip_all \
  --port 27017 \
  --auth \
  --keyFile "$key_file"

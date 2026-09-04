#!/usr/bin/env bash
set -euo pipefail
: "${AGENT_STAGE:?AGENT_STAGE is required}"
: "${AGENT_DATABASE_NAME:?AGENT_DATABASE_NAME is required}"
# The agent database is always isolated from anything else on the cluster. This
# is the check that makes a managed, SHARED cluster safe to point at: the service
# can only ever open agent_<stage>, never a database that belongs to something
# else living on the same cluster.
[[ "$AGENT_DATABASE_NAME" == "agent_${AGENT_STAGE//-/_}" ]] || exit 7

if [[ -n "${AGENT_MONGO_URI:-}" ]]; then
  # Managed provider: one URI carrying its own credentials and topology.
  [[ "$AGENT_MONGO_URI" == mongodb+srv://* || "$AGENT_MONGO_URI" == mongodb://* ]] || exit 7
  node - <<'NODE'
const fs = require('node:fs')
fs.writeFileSync('/run/stokd-agent/readiness-config.json', JSON.stringify({
  schemaVersion: '1.0', command: 'readiness', environment: process.env.AGENT_STAGE,
  databaseName: process.env.AGENT_DATABASE_NAME, mongoUri: process.env.AGENT_MONGO_URI,
}), { mode: 0o400 })
NODE
else
  : "${AGENT_RUNTIME_SECRET_VALUE:?AGENT_RUNTIME_SECRET_VALUE is required}"
  : "${AGENT_MONGO_HOST:?AGENT_MONGO_HOST is required}"
  : "${AGENT_REPLICA_SET:?AGENT_REPLICA_SET is required}"
  [[ "$AGENT_MONGO_HOST" == "mongo-${AGENT_STAGE}.sst:27017" ]] || exit 7
  [[ "$AGENT_REPLICA_SET" == agent-rs ]] || exit 7
  node - <<'NODE'
const fs = require('node:fs')
const secret = process.env.AGENT_RUNTIME_SECRET_VALUE
if (typeof secret !== 'string' || secret.length < 32) throw new Error('runtime credential is invalid')
fs.writeFileSync('/run/stokd-agent/runtime-credential.json', JSON.stringify({ runtimePassword: secret }), { mode: 0o400 })
fs.writeFileSync('/run/stokd-agent/readiness-config.json', JSON.stringify({
  schemaVersion: '1.0', command: 'readiness', environment: process.env.AGENT_STAGE,
  databaseName: process.env.AGENT_DATABASE_NAME, replicaSet: process.env.AGENT_REPLICA_SET,
  mongoHost: process.env.AGENT_MONGO_HOST,
}), { mode: 0o400 })
NODE
fi
unset AGENT_RUNTIME_SECRET_VALUE
exec node /opt/stokd-agent/api-entry.mjs

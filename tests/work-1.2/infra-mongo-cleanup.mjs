import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function executable(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`)
  chmodSync(path, 0o755)
}

test('failed loopback initialization terminates the exact owned no-auth mongod', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agent-mongo-cleanup-'))
  const bin = join(fixture, 'bin')
  const data = join(fixture, 'data')
  const runtime = join(fixture, 'runtime')
  const credentials = join(runtime, 'credentials')
  const credentialFiles = {
    runtime: join(credentials, 'runtime.secret'),
    migration: join(credentials, 'migration.secret'),
    backup: join(credentials, 'backup.secret'),
  }
  mkdirSync(bin)
  mkdirSync(data)
  mkdirSync(runtime)
  mkdirSync(credentials)
  writeFileSync(credentialFiles.runtime, `runtime-'special-$-password-0123456789`)
  writeFileSync(credentialFiles.migration, 'migration-"special-`-password-0123456789')
  writeFileSync(credentialFiles.backup, 'backup-special-\\-password-012345678901')
  for (const path of Object.values(credentialFiles)) chmodSync(path, 0o400)
  executable(join(bin, 'chown'), 'exit 0')
  executable(join(bin, 'stat'), "printf '400:0\\n'")
  executable(join(bin, 'openssl'), "printf 'fixture-replica-key-material\\n'")
  executable(join(bin, 'gosu'), 'shift\nexec "$@"')
  executable(join(bin, 'mongosh'), 'exit 42')
  executable(join(bin, 'mongod'), String.raw`
pid_file=''
db_path=''
while (($#)); do
  case "$1" in
    --pidfilepath) pid_file="$2"; shift 2 ;;
    --dbpath) db_path="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$pid_file" && -n "$db_path" ]]
/bin/bash -c 'exec -a "$1" /bin/sleep 300' _ "mongod --dbpath $db_path" </dev/null >/dev/null 2>&1 &
printf '%s\n' "$!" > "$pid_file"
`)

  let ownedPid
  try {
    const result = spawnSync('/bin/bash', [resolve(root, 'infra/runtime/mongo-entrypoint.sh')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AGENT_MONGO_RUNTIME_DIR: runtime,
        AGENT_MONGO_WAIT_ATTEMPTS: '1',
        MONGO_RUNTIME_CREDENTIAL_FILE: credentialFiles.runtime,
        MONGO_MIGRATION_CREDENTIAL_FILE: credentialFiles.migration,
        MONGO_BACKUP_CREDENTIAL_FILE: credentialFiles.backup,
        MONGO_DATA_DIR: data,
        MONGO_INITIALIZATION_PORT: '27199',
        MONGO_DATABASE: 'agent_source_val12',
        MONGO_REPLICA_HOST: 'mongo-source-val12.sst:27017',
      },
      timeout: 10_000,
    })
    assert.notEqual(result.status, 0, `failure injection unexpectedly succeeded: ${result.stdout}`)
    ownedPid = Number(readFileSync(join(runtime, 'standalone.pid'), 'utf8').trim())
    assert.ok(Number.isInteger(ownedPid) && ownedPid > 1)
    const probe = spawnSync('/bin/ps', ['-p', String(ownedPid), '-o', 'state='], { encoding: 'utf8' })
    assert.ok(probe.status !== 0 || /^Z/.test(probe.stdout.trim()), `no-auth mongod ${ownedPid} survived failed initialization`)
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /runtime-'special|migration-"special|backup-special/)
  } finally {
    if (Number.isInteger(ownedPid)) spawnSync('/bin/kill', ['-TERM', String(ownedPid)])
    rmSync(fixture, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_COLLECTIONS, AGENT_SCHEMA_VERSION, MINIMUM_COMPATIBLE_SCHEMA_VERSION, MONGODB_DATABASE_TOOLS_VERSION } from '../../packages/storage/lib/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const storagePackage = JSON.parse(readFileSync(join(root, 'packages/storage/package.json'), 'utf8'))
assert.equal(storagePackage.name, '@stokd-cloud/agent-storage')
assert.equal(storagePackage.dependencies.mongodb, '6.20.0')
assert.equal(storagePackage.dependencies['@aws-sdk/client-s3'], '3.883.0')
assert.equal(storagePackage.dependencies['@aws-sdk/client-ecs'], '3.883.0')
assert.equal(AGENT_SCHEMA_VERSION, 1)
assert.equal(MINIMUM_COMPATIBLE_SCHEMA_VERSION, 0)
assert.equal(MONGODB_DATABASE_TOOLS_VERSION, '100.14.0')
assert.equal(AGENT_COLLECTIONS.length, 25)

const indexes = new Map(AGENT_COLLECTIONS.map(collection => [collection.name, new Map(collection.indexes.map(index => [index.name, index]))]))
for (const [collection, name] of [
  ['agents', 'owner_normalized_name_unique'],
  ['conversation_events', 'conversation_sequence_unique'],
  ['idempotency_receipts', 'idempotency_scope_key_unique'],
  ['idempotency_receipts', 'command_id_unique'],
  ['coordinator_leases', 'lease_generation'],
  ['artifact_versions', 'object_version_unique'],
  ['restore_reconciliations', 'backup_restore_unique'],
]) {
  assert.equal(indexes.get(collection)?.get(name)?.unique, true, `missing frozen unique index ${collection}.${name}`)
}

for (const file of readdirSync(join(root, 'packages/storage/src')).filter(name => name.endsWith('.ts'))) {
  const source = readFileSync(join(root, 'packages/storage/src', file), 'utf8')
  assert.doesNotMatch(source, /@stokd-cloud\/(?:db|database|api-client)|stokd-cloud\/mono|stokd[^\n]*database[^\n]*client/i, `${file} crosses the standalone Agent storage boundary`)
}

const maintenance = readFileSync(join(root, 'packages/storage/src/maintenance-cli.ts'), 'utf8')
for (const command of ['migrate', 'readiness', 'validation-seed', 'validation-read', 'backup', 'restore-offline', 'restore-finalize']) assert.match(maintenance, new RegExp(`'${command.replace('-', '\\-')}'`))
assert.match(maintenance, /DescribeServicesCommand/)
assert.match(maintenance, /assertFileOwnership/)
assert.match(maintenance, /0o400/)
assert.match(maintenance, /0o600/)

const recovery = readFileSync(join(root, 'packages/storage/src/recovery.ts'), 'utf8')
assert.match(recovery, /dispatchBoundaryAfter\.accepted !== dispatchBoundaryBefore\.accepted/)
assert.match(recovery, /dispatchBoundaryAfter\.launched !== dispatchBoundaryBefore\.launched/)
assert.match(recovery, /recoveryMode: 'restored_observation'/)

console.log(JSON.stringify({ ok: true, collections: AGENT_COLLECTIONS.length, package: storagePackage.name, commands: 7 }))

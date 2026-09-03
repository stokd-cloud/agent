import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { captureProtectedMongoListener, startAuthenticatedReplica } from '../fixtures/work-1.2/mongo-replica.mjs'
import {
  AGENT_COLLECTIONS,
  AGENT_MIGRATION_CHECKSUM,
  AgentStorageError,
  acquireCoordinatorLease,
  assertCoordinatorFence,
  bsonInt64,
  claimIdempotencyReceipt,
  compareAndSwapRevision,
  insertRevisioned,
  migrateAgentStorage,
  openAgentStorage,
  releaseCoordinatorLease,
  renewCoordinatorLease,
  verifyStorageCatalog,
  withAgentTransaction,
} from '../../packages/storage/lib/index.js'

const storageRequire = createRequire(new URL('../../packages/storage/package.json', import.meta.url))
const { Long, MongoClient } = storageRequire('mongodb')
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

const temporary = mkdtempSync(join(tmpdir(), 'agent-work-1.2-schema-'))
const protectedListenerBefore = captureProtectedMongoListener()
const replica = await startAuthenticatedReplica({ environment: 'test-schema', temporaryParent: temporary })
const result = { schemaVersion: '1.0', mongo: { version: '7.0.29', port: replica.port, pid: replica.pid, replicaSet: replica.replicaSet }, checks: [] }
let migrationWorker = null
let takeoverReplica = null
let takeoverWorker = null
let finalOutput = null

try {
  assert.notEqual(replica.port, 27017)
  assert.ok(replica.pid > 1)
  const runtimeConfig = { uri: replica.runtimeUri, environment: 'test-schema', expectedReplicaSet: replica.replicaSet, principal: 'runtime' }
  const migrationConfig = { uri: replica.migrationUri, environment: 'test-schema', expectedReplicaSet: replica.replicaSet, principal: 'migration' }

  const missingPath = new URL(replica.runtimeUri)
  missingPath.pathname = '/'
  await assert.rejects(openAgentStorage({ ...runtimeConfig, uri: missingPath.toString() }), error => error.code === 'invalid_storage_config' && /URI database/.test(error.message))
  const missingAuthSource = new URL(replica.runtimeUri)
  missingAuthSource.searchParams.delete('authSource')
  await assert.rejects(openAgentStorage({ ...runtimeConfig, uri: missingAuthSource.toString() }), error => error.code === 'invalid_storage_config' && /authenticate against/.test(error.message))
  await assert.rejects(openAgentStorage({ ...runtimeConfig, uri: replica.migrationUri }), error => error.code === 'invalid_storage_config' && /authenticate against/.test(error.message))

  await assert.rejects(openAgentStorage(runtimeConfig), error => error instanceof AgentStorageError && error.code === 'storage_not_ready')
  const preflightClient = new MongoClient(replica.runtimeUri)
  await preflightClient.connect()
  assert.equal((await preflightClient.db(replica.databaseName).listCollections({}, { nameOnly: true }).toArray()).length, 0, 'service startup mutated an uninitialized database')
  await assert.rejects(preflightClient.db('stokd').collection('agents').insertOne({ forbidden: true }), error => /not authorized|Unauthorized/i.test(String(error)))
  await assert.rejects(preflightClient.db('admin').command({ getParameter: 1, featureCompatibilityVersion: 1 }), error => /not authorized|Unauthorized/i.test(String(error)))
  await preflightClient.close()
  await assert.rejects(openAgentStorage(runtimeConfig, { migrate: true }), error => error.code === 'invalid_storage_config' && /migrations require/.test(error.message))
  await assert.rejects(openAgentStorage(migrationConfig), error => error.code === 'invalid_storage_config' && /service startup requires/.test(error.message))
  result.checks.push('read-only-service-preflight-and-principal-boundaries')

  const migrationClient = new MongoClient(replica.migrationUri)
  await migrationClient.connect()
  const migrationDb = migrationClient.db(replica.databaseName)
  const fcv = await migrationDb.admin().command({ getParameter: 1, featureCompatibilityVersion: 1 })
  assert.equal(fcv.featureCompatibilityVersion.version, '7.0')
  await migrationDb.collection('accounts').insertOne({ _id: 'legacy-owner', ownerSubject: 'own_legacy01', label: 'pre-migration-state' })
  await migrationClient.close()

  const marker = join(temporary, 'migration-paused.json')
  const child = spawn(process.execPath, ['tests/fixtures/work-1.2/migration-worker.mjs'], {
    cwd: new URL('../..', import.meta.url),
    env: {
      ...process.env,
      AGENT_MIGRATION_MARKER: marker,
      AGENT_MIGRATION_URI: replica.migrationUri,
      AGENT_MIGRATION_ENVIRONMENT: 'test-schema',
      AGENT_MIGRATION_REPLICA_SET: replica.replicaSet,
      NODE_PATH: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  migrationWorker = child
  const deadline = Date.now() + 20_000
  while (!existsSync(marker) && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`migration worker exited before pause: ${child.exitCode}`)
    await sleep(50)
  }
  assert.ok(existsSync(marker), 'migration worker did not journal a step')
  const markerValue = JSON.parse(readFileSync(marker, 'utf8'))
  assert.equal(markerValue.pid, child.pid)
  assert.ok(child.pid > 1)
  child.kill('SIGKILL')
  await new Promise(resolve => child.once('exit', resolve))
  migrationWorker = null
  await sleep(450)

  const migrated = await openAgentStorage(migrationConfig, { migrate: true })
  assert.equal(migrated.migration?.applied, true)
  assert.equal(migrated.migration?.resumed, true)
  await verifyStorageCatalog(migrated.db)
  const schema = await migrated.db.collection('schema_state').findOne({ _id: 'agent-schema' })
  assert.equal(schema.schemaVersion, 1)
  assert.equal(schema.migrationStatus, 'ready')
  assert.equal(schema.migrationChecksum, AGENT_MIGRATION_CHECKSUM)
  assert.equal(await migrated.db.collection('accounts').countDocuments({ _id: 'legacy-owner', label: 'pre-migration-state' }), 1)
  await migrated.close()
  const repeatedClient = new MongoClient(replica.migrationUri)
  await repeatedClient.connect()
  const repeated = await migrateAgentStorage(repeatedClient.db(replica.databaseName))
  assert.equal(repeated.applied, false)
  await repeatedClient.close()
  result.checks.push('real-process-kill-expired-lease-resume-repeat-and-old-state')

  takeoverReplica = await startAuthenticatedReplica({ environment: 'test-migration-fence', temporaryParent: temporary })
  const takeoverMarker = join(temporary, 'takeover-migration-paused.json')
  const takeoverRelease = join(temporary, 'takeover-migration-release')
  takeoverWorker = spawn(process.execPath, ['tests/fixtures/work-1.2/migration-worker.mjs'], {
    cwd: new URL('../..', import.meta.url),
    env: {
      ...process.env,
      AGENT_MIGRATION_MARKER: takeoverMarker,
      AGENT_MIGRATION_RELEASE_MARKER: takeoverRelease,
      AGENT_MIGRATION_URI: takeoverReplica.migrationUri,
      AGENT_MIGRATION_ENVIRONMENT: 'test-migration-fence',
      AGENT_MIGRATION_REPLICA_SET: takeoverReplica.replicaSet,
      NODE_PATH: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let takeoverWorkerOutput = ''
  takeoverWorker.stdout.on('data', value => { takeoverWorkerOutput += value })
  takeoverWorker.stderr.on('data', value => { takeoverWorkerOutput += value })
  const takeoverDeadline = Date.now() + 20_000
  while (!existsSync(takeoverMarker) && Date.now() < takeoverDeadline) {
    if (takeoverWorker.exitCode !== null) throw new Error(`takeover migration worker exited before pause: ${takeoverWorker.exitCode}\n${takeoverWorkerOutput}`)
    await sleep(50)
  }
  assert.ok(existsSync(takeoverMarker), 'old migrator did not reach its journaled pause')
  await sleep(450)
  const newerMigrator = await openAgentStorage({ uri: takeoverReplica.migrationUri, environment: 'test-migration-fence', expectedReplicaSet: takeoverReplica.replicaSet, principal: 'migration' }, { migrate: true })
  assert.equal(newerMigrator.migration?.resumed, true)
  const completedRunBeforeOldRelease = await newerMigrator.db.collection('migration_runs').findOne({ targetVersion: 1 })
  assert.equal(completedRunBeforeOldRelease.status, 'complete')
  const winningToken = completedRunBeforeOldRelease.migrationToken
  writeFileSync(takeoverRelease, 'release', { mode: 0o600 })
  const oldExit = await new Promise(resolve => takeoverWorker.once('exit', (code, signal) => resolve({ code, signal })))
  takeoverWorker = null
  assert.equal(oldExit.code, 1, takeoverWorkerOutput)
  const completedRunAfterOldRelease = await newerMigrator.db.collection('migration_runs').findOne({ targetVersion: 1 })
  assert.equal(completedRunAfterOldRelease.status, 'complete')
  assert.equal(completedRunAfterOldRelease.migrationToken, winningToken)
  const takeoverSchema = await newerMigrator.db.collection('schema_state').findOne({ _id: 'agent-schema' })
  assert.equal(takeoverSchema.migrationStatus, 'ready')
  await newerMigrator.close()
  await takeoverReplica.stop()
  takeoverReplica = null
  result.checks.push('expired-lease-two-worker-takeover-fences-stale-error-write')

  const nonReadyCurrent = new MongoClient(replica.migrationUri)
  await nonReadyCurrent.connect()
  await nonReadyCurrent.db(replica.databaseName).collection('schema_state').updateOne({ _id: 'agent-schema' }, { $set: { migrationStatus: 'interrupted' } })
  await assert.rejects(migrateAgentStorage(nonReadyCurrent.db(replica.databaseName)), error => error.code === 'migration_conflict' && /not ready/.test(error.message))
  await assert.rejects(openAgentStorage(runtimeConfig), error => error.code === 'migration_conflict' && /not ready/.test(error.message))
  await nonReadyCurrent.db(replica.databaseName).collection('schema_state').updateOne({ _id: 'agent-schema' }, { $set: { migrationStatus: 'ready' } })
  await nonReadyCurrent.close()
  result.checks.push('current-version-nonready-state-refuses-service-and-migrator')

  const storage = await openAgentStorage(runtimeConfig)
  assert.equal(storage.readiness.featureCompatibilityVerified, false)
  assert.equal(AGENT_COLLECTIONS.length, (await storage.db.listCollections({}, { nameOnly: true }).toArray()).filter(value => AGENT_COLLECTIONS.some(entry => entry.name === value.name)).length)
  await withAgentTransaction(storage.db, async session => {
    await storage.db.collection('audit_events').insertOne({ auditId: 'audit-void', ownerSubject: 'own_12345678', occurredAt: new Date() }, { session })
  })

  const inserted = await insertRevisioned(storage.db, 'agents', { _id: 'agent-cas', ownerSubject: 'own_12345678', agentId: 'agt_12345678', normalizedName: 'cas-agent', state: 'active', counter: Long.ZERO })
  const swapped = await compareAndSwapRevision(storage.db, 'agents', inserted._id, inserted.ownerSubject, Long.ONE, { $set: { normalizedName: 'cas-agent-updated' }, $inc: { counter: Long.ONE } })
  assert.equal(swapped.revision.toString(), '2')
  assert.equal(swapped.counter.toString(), '1')
  await assert.rejects(compareAndSwapRevision(storage.db, 'agents', inserted._id, inserted.ownerSubject, Long.ONE, { $set: { normalizedName: 'stale' } }), error => error.code === 'revision_conflict')
  await assert.rejects(storage.db.collection('agents').insertOne({ _id: 'agent-duplicate', ownerSubject: 'own_12345678', agentId: 'agt_87654321', normalizedName: 'cas-agent-updated', state: 'active' }), error => error.code === 11000)
  await storage.db.collection('conversation_events').insertOne({ eventId: 'evt_12345678', conversationId: 'cnv_12345678', agentId: 'agt_12345678', sequence: 1, occurredAt: new Date() })
  await assert.rejects(storage.db.collection('conversation_events').insertOne({ eventId: 'evt_87654321', conversationId: 'cnv_12345678', agentId: 'agt_12345678', sequence: 1, occurredAt: new Date() }), error => error.code === 11000)

  const lease1 = await acquireCoordinatorLease(storage.db, 'agt_12345678', 'host-one')
  assert.ok(lease1.generation instanceof Long)
  await assert.rejects(acquireCoordinatorLease(storage.db, 'agt_12345678', 'host-two'), error => error.code === 'stale_fence')
  await releaseCoordinatorLease(storage.db, lease1)
  const lease2 = await acquireCoordinatorLease(storage.db, 'agt_12345678', 'host-two')
  assert.equal(lease2.generation.toString(), '2')
  await assert.rejects(assertCoordinatorFence(storage.db, lease1), error => error.code === 'stale_fence')
  await assert.rejects(acquireCoordinatorLease(storage.db, 'agt_duration', 'host', 0), error => error.code === 'stale_fence')
  await assert.rejects(renewCoordinatorLease(storage.db, lease2, 0), error => error.code === 'stale_fence')
  const expiring = await acquireCoordinatorLease(storage.db, 'agt_expiry1', 'host-before', 1)
  assert.equal(expiring.leaseExpiresAt.getTime() - expiring.serverTime.getTime(), 1_000)
  await sleep(1_100)
  const takeover = await acquireCoordinatorLease(storage.db, 'agt_expiry1', 'host-after', 1)
  assert.equal(takeover.generation.toString(), '2')
  await assert.rejects(assertCoordinatorFence(storage.db, expiring), error => error.code === 'stale_fence')

  const firstClaim = await withAgentTransaction(storage.db, session => claimIdempotencyReceipt(storage.db, { ownerSubject: 'own_12345678', scope: 'conversation.message', idempotencyKey: 'idem-1', commandId: 'cmd_12345678', request: { text: 'hello' } }, session))
  assert.equal(firstClaim.replay, false)
  const replay = await withAgentTransaction(storage.db, session => claimIdempotencyReceipt(storage.db, { ownerSubject: 'own_12345678', scope: 'conversation.message', idempotencyKey: 'idem-1', commandId: 'cmd_12345678', request: { text: 'hello' } }, session))
  assert.equal(replay.replay, true)
  await assert.rejects(withAgentTransaction(storage.db, session => claimIdempotencyReceipt(storage.db, { ownerSubject: 'own_12345678', scope: 'conversation.message', idempotencyKey: 'idem-1', commandId: 'cmd_12345678', request: { text: 'changed' } }, session)), error => error.code === 'idempotency_conflict')
  await assert.rejects(withAgentTransaction(storage.db, session => claimIdempotencyReceipt(storage.db, { ownerSubject: 'own_12345678', scope: 'conversation.message', idempotencyKey: 'idem-other', commandId: 'cmd_12345678', request: { text: 'hello' } }, session)), error => error.code === 'idempotency_conflict')
  assert.equal(bsonInt64('9223372036854775806').toString(), '9223372036854775806')
  result.checks.push('transactions-cas-bson-int64-fencing-and-transactional-idempotency')
  await storage.close()

  const incompatible = new MongoClient(replica.migrationUri)
  await incompatible.connect()
  await incompatible.db(replica.databaseName).collection('migration_runs').drop()
  await incompatible.db(replica.databaseName).collection('schema_state').updateOne({ _id: 'agent-schema' }, { $set: { schemaVersion: 99 } })
  const incompatibleCollections = (await incompatible.db(replica.databaseName).listCollections({}, { nameOnly: true }).toArray()).map(value => value.name).sort()
  await incompatible.close()
  await assert.rejects(openAgentStorage(runtimeConfig), error => error.code === 'unsupported_schema_version')
  await assert.rejects(openAgentStorage(migrationConfig, { migrate: true }), error => error.code === 'unsupported_schema_version')
  const afterIncompatible = new MongoClient(replica.runtimeUri)
  await afterIncompatible.connect()
  assert.deepEqual((await afterIncompatible.db(replica.databaseName).listCollections({}, { nameOnly: true }).toArray()).map(value => value.name).sort(), incompatibleCollections)
  assert.equal(await afterIncompatible.db(replica.databaseName).listCollections({ name: 'migration_runs' }, { nameOnly: true }).hasNext(), false)
  await afterIncompatible.close()
  result.checks.push('mixed-version-startup-and-migration-refuse-before-writes')

  finalOutput = { ...result, ok: true, collectionCount: AGENT_COLLECTIONS.length }
} finally {
  if (migrationWorker && migrationWorker.exitCode === null) {
    assert.ok(migrationWorker.pid > 1)
    migrationWorker.kill('SIGKILL')
    await new Promise(resolve => migrationWorker.once('exit', resolve))
  }
  if (takeoverWorker && takeoverWorker.exitCode === null) {
    assert.ok(takeoverWorker.pid > 1)
    takeoverWorker.kill('SIGKILL')
    await new Promise(resolve => takeoverWorker.once('exit', resolve))
  }
  if (takeoverReplica) await takeoverReplica.stop().catch(() => undefined)
  await replica.stop()
  rmSync(temporary, { recursive: true, force: true })
  assert.deepEqual(captureProtectedMongoListener(), protectedListenerBefore, 'protected MongoDB listener changed during the disposable schema scenario')
}
if (finalOutput) console.log(JSON.stringify({ ...finalOutput, protectedDefaultListenerUnchanged: true }, null, 2))

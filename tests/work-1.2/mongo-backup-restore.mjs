import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalVersionStore } from '../fixtures/work-1.2/local-version-store.mjs'
import { captureProtectedMongoListener, resolveMongoTools, startAuthenticatedReplica } from '../fixtures/work-1.2/mongo-replica.mjs'
import {
  createReplicaSetBackup,
  finalizeRestoredBackup,
  internalRestoreValidation,
  openAgentStorage,
  parseBackupManifestBytes,
  restoreBackupOffline,
  restoreReplicaSetBackup,
} from '../../packages/storage/lib/index.js'

const storageRequire = createRequire(new URL('../../packages/storage/package.json', import.meta.url))
const { MongoClient } = storageRequire('mongodb')
const temporary = mkdtempSync(join(tmpdir(), 'agent-work-1.2-restore-'))
const protectedListenerBefore = captureProtectedMongoListener()
const versionStore = new LocalVersionStore(join(temporary, 'versions'))
const sourceCredentials = {
  runtime: { username: 'agent_runtime', password: 'Src% /#@+ space runtime 123456' },
  migration: { username: 'agent_migration', password: 'Src% /#@+ space migration 123' },
  backup: { username: 'agent_backup', password: 'Src% /#@+ space backup 1234567' },
}
const source = await startAuthenticatedReplica({ environment: 'test-source', temporaryParent: temporary, principalCredentials: sourceCredentials })
const target = await startAuthenticatedReplica({ environment: 'restore-val12', temporaryParent: temporary })
const targetInitialCredentialUris = { runtime: target.runtimeUri, migration: target.migrationUri, backup: target.backupUri }
const tools = resolveMongoTools()
const result = {
  schemaVersion: '1.0',
  mongo: { version: '7.0.29', sourcePort: source.port, sourcePid: source.pid, targetPort: target.port, targetPid: target.pid },
  tools: { version: '100.14.0' },
  checks: [],
}
let finalOutput = null

const encode = encodeURIComponent
function uriFor({ username, password }, address, database, authSource, replicaSet) {
  return `mongodb://${encode(username)}:${encode(password)}@${address}/${database}?authSource=${encode(authSource)}&replicaSet=${encode(replicaSet)}`
}
function principalSet(cycle) {
  const password = kind => `New% /#@+ space ${kind} cycle ${cycle} 123456`
  const migrationRole = `agentMigration_restore_${cycle}`
  return [
    { kind: 'runtime', username: 'agent_runtime', authDatabase: target.databaseName, newPassword: password('runtime'), secretVersionId: `secret-runtime-cycle-${cycle}`, roles: [{ role: 'readWrite', db: target.databaseName }] },
    {
      kind: 'migration', username: 'agent_migration', authDatabase: 'admin', newPassword: password('migration'), secretVersionId: `secret-migration-cycle-${cycle}`, roles: [{ role: migrationRole, db: 'admin' }],
      roleDefinition: { role: migrationRole, privileges: [{ resource: { cluster: true }, actions: ['getParameter'] }], roles: [{ role: 'readWrite', db: target.databaseName }, { role: 'dbAdmin', db: target.databaseName }] },
    },
    { kind: 'backup', username: 'agent_backup', authDatabase: 'admin', newPassword: password('backup'), secretVersionId: `secret-backup-cycle-${cycle}`, roles: [{ role: 'backup', db: 'admin' }, { role: 'clusterMonitor', db: 'admin' }] },
  ]
}
function credentialUris(principals) {
  const byKind = new Map(principals.map(value => [value.kind, value]))
  return {
    runtime: uriFor({ username: 'agent_runtime', password: byKind.get('runtime').newPassword }, target.address, target.databaseName, target.databaseName, target.replicaSet),
    migration: uriFor({ username: 'agent_migration', password: byKind.get('migration').newPassword }, target.address, target.databaseName, 'admin', target.replicaSet),
    backup: uriFor({ username: 'agent_backup', password: byKind.get('backup').newPassword }, target.address, '', 'admin', target.replicaSet),
  }
}
function archivedCredentialProbes(priorCredentials) {
  return [
    { origin: 'source_archive', kind: 'runtime', uri: uriFor(sourceCredentials.runtime, target.address, source.databaseName, source.databaseName, target.replicaSet) },
    { origin: 'source_archive', kind: 'migration', uri: uriFor(sourceCredentials.migration, target.address, source.databaseName, 'admin', target.replicaSet) },
    { origin: 'source_archive', kind: 'backup', uri: uriFor(sourceCredentials.backup, target.address, '', 'admin', target.replicaSet) },
    { origin: 'target_pre_restore', kind: 'runtime', uri: uriFor(priorCredentials.runtime, target.address, target.databaseName, target.databaseName, target.replicaSet) },
    { origin: 'target_pre_restore', kind: 'migration', uri: uriFor(priorCredentials.migration, target.address, target.databaseName, 'admin', target.replicaSet) },
    { origin: 'target_pre_restore', kind: 'backup', uri: uriFor(priorCredentials.backup, target.address, '', 'admin', target.replicaSet) },
  ]
}
async function assertAuthDenied(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2_000 })
  try {
    await assert.rejects(client.connect(), error => error?.code === 18 && error?.codeName === 'AuthenticationFailed')
  } finally {
    await client.close().catch(() => undefined)
  }
}

try {
  assert.notEqual(source.port, 27017)
  assert.notEqual(target.port, 27017)
  assert.ok(source.pid > 1)
  assert.ok(target.pid > 1)

  const migratedSource = await openAgentStorage({ uri: source.migrationUri, environment: 'test-source', expectedReplicaSet: source.replicaSet, principal: 'migration' }, { migrate: true })
  await migratedSource.close()
  const sourceStorage = await openAgentStorage({ uri: source.runtimeUri, environment: 'test-source', expectedReplicaSet: source.replicaSet, principal: 'runtime' })
  const now = new Date()
  const sourceBucket = source.resourceIds.artifactBucket
  const sourceKms = source.resourceIds.kmsKeyArn
  let good = versionStore.putBytes({ bucket: sourceBucket, objectKey: 'agents/owner/avatar good.bin', kmsKeyId: sourceKms, bytes: Buffer.from('good durable artifact') })
  const missing = versionStore.putBytes({ bucket: sourceBucket, objectKey: 'agents/owner/missing.bin', kmsKeyId: sourceKms, bytes: Buffer.from('missing after backup') })
  const omitted = versionStore.putBytes({ bucket: sourceBucket, objectKey: 'agents/owner/omitted.bin', kmsKeyId: sourceKms, bytes: Buffer.from('omitted from manifest') })
  versionStore.deleteVersion(missing)

  const seed = async (name, document) => sourceStorage.db.collection(name).insertOne(document)
  await seed('agents', { agentId: 'agt_restore01', ownerSubject: 'own_restore01', normalizedName: 'restore-agent', state: 'active', createdAt: now })
  await seed('agent_profile_revisions', { agentId: 'agt_restore01', ownerSubject: 'own_restore01', revision: 1, createdAt: now })
  await seed('conversations', { conversationId: 'cnv_restore01', agentId: 'agt_restore01', updatedAt: now })
  await seed('conversation_events', { eventId: 'evt_restore01', conversationId: 'cnv_restore01', agentId: 'agt_restore01', sequence: 1, occurredAt: now })
  await seed('memories', { memoryId: 'mem_restore01', agentId: 'agt_restore01', scope: 'agent', state: 'current' })
  await seed('memory_revisions', { memoryId: 'mem_restore01', revision: 1 })
  await seed('commitments', { commitmentId: 'cmt_restore01', agentId: 'agt_restore01', state: 'active', updatedAt: now })
  await seed('wakes', { wakeId: 'wak_restore01', agentId: 'agt_restore01', ingressSequence: 1, state: 'queued', queuedAt: now })
  await seed('wake_attempts', { attemptId: 'atm_restore01', wakeId: 'wak_restore01', generation: 1 })
  await seed('work_requests', { workId: 'wrk_restore01', agentId: 'agt_restore01', workAttemptGeneration: 1, state: 'pending', updatedAt: now })
  await seed('approvals', { approvalId: 'apr_restore01', attemptId: 'atm_restore01', actionHash: 'action-hash', state: 'pending', expiresAt: new Date(now.getTime() + 60_000) })
  await seed('dispatch_intents', { intentId: 'intent_restore01', workId: 'wrk_restore01', workAttemptGeneration: 1, intentHash: 'intent-hash', state: 'accepted' })
  await seed('audit_events', { auditId: 'audit_restore01', ownerSubject: 'own_restore01', eventType: 'executor.launch', occurredAt: now })
  for (const [ordinal, custody] of [good, missing, omitted].entries()) {
    await seed('artifact_versions', {
      versionId: `arv_restore0${ordinal + 1}`,
      artifactId: `art_restore0${ordinal + 1}`,
      ordinal: 1,
      agentId: 'agt_restore01',
      state: 'ready',
      createdAt: now,
      bucket: custody.bucket,
      objectKey: custody.objectKey,
      s3VersionId: custody.versionId,
      eTag: custody.eTag,
      sha256: custody.sha256,
      byteLength: custody.byteLength,
      kmsKeyId: custody.kmsKeyId,
      custodyCapturedAt: new Date(custody.capturedAt),
    })
  }

  const sourceQuiesceProof = { schemaVersion: '1.0', proofId: 'aqp_library_restore_01', sourceEnvironment: 'test-source', apiDesiredCount: 0, apiRunningCount: 0, observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString(), sourceResourceIds: source.resourceIds }
  const replacementGood = versionStore.putBytes({ bucket: sourceBucket, objectKey: good.objectKey, kmsKeyId: sourceKms, bytes: Buffer.from('changed during mongodump') })
  const dumpMarker = join(temporary, 'dump-started.marker')
  const mutationAck = join(temporary, 'object-mutated.ack')
  const dumpWrapper = join(temporary, 'mongodump-race-wrapper.sh')
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
  writeFileSync(dumpWrapper, `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then exec ${quote(tools.mongodumpPath)} --version; fi
: > ${quote(dumpMarker)}
i=0
while [ ! -f ${quote(mutationAck)} ]; do i=$((i+1)); [ "$i" -lt 600 ] || exit 70; sleep 0.05; done
exec ${quote(tools.mongodumpPath)} "$@"
`, { mode: 0o700 })
  chmodSync(dumpWrapper, 0o700)
  const mutationWorkerPath = new URL('../fixtures/work-1.2/mutate-object-during-dump.mjs', import.meta.url).pathname
  const mutationWorker = spawn(process.execPath, [mutationWorkerPath], {
    env: { ...process.env, MONGO_URI: source.runtimeUri, MONGO_DATABASE: source.databaseName, ARTIFACT_VERSION_ID: 'arv_restore01', REPLACEMENT_CUSTODY_JSON: JSON.stringify(replacementGood), DUMP_MARKER_PATH: dumpMarker, MUTATION_ACK_PATH: mutationAck },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let mutationOutput = ''
  mutationWorker.stdout.on('data', value => { mutationOutput += value })
  mutationWorker.stderr.on('data', value => { mutationOutput += value })
  const mutationCompleted = new Promise(resolve => mutationWorker.once('exit', (code, signal) => resolve({ code, signal })))
  let racePublications = 0
  await assert.rejects(createReplicaSetBackup({
    db: sourceStorage.db,
    backupUri: source.backupUri,
    mongodumpPath: dumpWrapper,
    archivePath: join(temporary, 'race.archive.gz'),
    sourceEnvironment: 'test-source',
    sourceDatabase: source.databaseName,
    sourceResourceIds: source.resourceIds,
    sourceSecretVersionIds: { runtime: 'source-runtime-version-001', migration: 'source-migration-version-001', backup: 'source-backup-version-001' },
    sourceResourceIdentityProbe: { inspect: async () => source.resourceIds },
    admissionQuiesceProof: sourceQuiesceProof,
    admissionQuiesceProbe: { inspect: async () => sourceQuiesceProof },
    objects: [good, missing, omitted],
    custodyMode: 'local_evidence',
    publishArchive: async () => { racePublications += 1; throw new Error('race archive must not publish') },
    publishManifest: async () => { racePublications += 1; throw new Error('race manifest must not publish') },
  }), error => error?.code === 'backup_failed' && /changed during/.test(error.message))
  const mutationResult = await mutationCompleted
  assert.deepEqual(mutationResult, { code: 0, signal: null }, mutationOutput)
  assert.equal(racePublications, 0)
  good = replacementGood
  result.checks.push('object-custody-mutation-during-dump-refuses-all-publication')

  const archivePath = join(temporary, 'source.archive.gz')
  const backup = await createReplicaSetBackup({
    db: sourceStorage.db,
    backupUri: source.backupUri,
    mongodumpPath: tools.mongodumpPath,
    archivePath,
    sourceEnvironment: 'test-source',
    sourceDatabase: source.databaseName,
    sourceResourceIds: source.resourceIds,
    sourceSecretVersionIds: { runtime: 'source-runtime-version-001', migration: 'source-migration-version-001', backup: 'source-backup-version-001' },
    sourceResourceIdentityProbe: { inspect: async () => source.resourceIds },
    admissionQuiesceProof: sourceQuiesceProof,
    admissionQuiesceProbe: { inspect: async () => sourceQuiesceProof },
    objects: [good, missing, omitted],
    custodyMode: 'local_evidence',
    publishArchive: versionStore.publishArchive({ bucket: source.resourceIds.backupBucket, objectKey: 'daily/source.archive.gz', kmsKeyId: source.resourceIds.kmsKeyArn }),
    publishManifest: versionStore.publishManifest({ bucket: source.resourceIds.backupBucket, objectKey: 'daily/source.manifest.json', kmsKeyId: source.resourceIds.kmsKeyArn }),
  })
  await sourceStorage.close()
  assert.equal(backup.manifest.archive.fullReplicaSet, true)
  assert.equal(backup.manifest.archive.oplogIncluded, true)
  assert.deepEqual(backup.manifest.observedDatabaseInventory.filter(name => !['admin', 'config', 'local'].includes(name)), [source.databaseName])
  result.checks.push('full-replica-set-oplog-backup-and-version-custody')

  const manifestJson = JSON.parse(Buffer.from(backup.manifestBytes).toString('utf8'))
  assert.throws(() => parseBackupManifestBytes(Buffer.from(JSON.stringify({ ...manifestJson, schemaVersion: '2.0' }))), error => error?.code === 'restore_failed' && /version pins/.test(error.message))
  assert.throws(() => parseBackupManifestBytes(Buffer.from(JSON.stringify({ ...manifestJson, unknownField: true }))), error => error?.code === 'restore_failed' && /fields/.test(error.message))
  assert.throws(() => parseBackupManifestBytes(Buffer.from(JSON.stringify({ ...manifestJson, objectManifestSha256: '0'.repeat(64) }))), error => error?.code === 'restore_failed' && /object checksum/.test(error.message))
  result.checks.push('manifest-schema-and-object-checksum-fail-before-restore')

  const staleTargetClient = new MongoClient(target.runtimeUri)
  await staleTargetClient.connect()
  await staleTargetClient.db(target.databaseName).collection('stale_pre_restore').insertOne({ mustBeRemoved: true })
  await staleTargetClient.close()

  const signingKey = randomBytes(32)
  const cycle1 = principalSet(1)
  const maintenance1 = await target.maintenanceController.enter(target.targetIdentity)
  assert.doesNotThrow(() => internalRestoreValidation.assertNoAuthMaintenanceTarget(
    maintenance1.noAuthUri,
    { ...maintenance1.proof, processStartIdentity: `linux:${maintenance1.proof.ownedProcessId}:1` },
    target.targetIdentity,
    'test-source',
  ))
  assert.throws(() => internalRestoreValidation.assertNormalBaseUri(
    `mongodb://${target.address},127.0.0.1:1/?replicaSet=${target.replicaSet}`,
    target.targetIdentity,
    'test-source',
  ), error => error?.code === 'restore_failed' && /restore URI is invalid|only the declared single/.test(error.message))
  const preWriteClient = new MongoClient(maintenance1.noAuthUri)
  await preWriteClient.connect()
  assert.equal(await preWriteClient.db(target.databaseName).collection('stale_pre_restore').countDocuments({}), 1)
  await assert.rejects(restoreBackupOffline({
    manifestBytes: backup.manifestBytes,
    manifestCustody: backup.manifestCustody,
    archiveCustody: { ...backup.manifest.archive.custody, versionId: `${backup.manifest.archive.custody.versionId}-wrong` },
    localArchivePath: backup.transientArchivePath,
    mongorestorePath: tools.mongorestorePath,
    target: target.targetIdentity,
    principals: cycle1,
    noAuthUri: maintenance1.noAuthUri,
    maintenanceProof: maintenance1.proof,
    receiptSigningKey: signingKey,
    requireVersionedObjectCustody: false,
  }), error => error?.code === 'restore_failed' && /VersionId/.test(error.message))
  assert.equal(await preWriteClient.db(target.databaseName).collection('stale_pre_restore').countDocuments({}), 1)
  await preWriteClient.close()
  result.checks.push('archive-version-binding-and-single-member-target-fail-before-write')
  const receipt1 = await restoreBackupOffline({
    manifestBytes: backup.manifestBytes,
    manifestCustody: backup.manifestCustody,
    archiveCustody: backup.manifest.archive.custody,
    localArchivePath: backup.transientArchivePath,
    mongorestorePath: tools.mongorestorePath,
    target: target.targetIdentity,
    principals: cycle1,
    noAuthUri: maintenance1.noAuthUri,
    maintenanceProof: maintenance1.proof,
    receiptSigningKey: signingKey,
    requireVersionedObjectCustody: false,
  })
  const normal1 = await maintenance1.enableAuth()
  await maintenance1.close()

  const badTransportProbe = archivedCredentialProbes(target.credentials)
  badTransportProbe[0] = { ...badTransportProbe[0], uri: `${badTransportProbe[0].uri}&tls=true` }
  await assert.rejects(finalizeRestoredBackup({
    receipt: receipt1,
    receiptSigningKey: signingKey,
    manifestBytes: backup.manifestBytes,
    manifestCustody: backup.manifestCustody,
    normalBaseUri: normal1.normalBaseUri,
    target: target.targetIdentity,
    principals: cycle1,
    archivedCredentialProbes: badTransportProbe,
    objectTransport: versionStore.restoreTransport({ targetBucket: target.resourceIds.artifactBucket, targetKmsKeyId: target.resourceIds.kmsKeyArn }),
  }), error => error?.code === 'restore_failed' && /authentication decision/.test(error.message))
  result.checks.push('credential-denial-distinguishes-network-or-tls-failure')

  let interrupted = false
  await assert.rejects(finalizeRestoredBackup({
    receipt: receipt1,
    receiptSigningKey: signingKey,
    manifestBytes: backup.manifestBytes,
    manifestCustody: backup.manifestCustody,
    normalBaseUri: normal1.normalBaseUri,
    target: target.targetIdentity,
    principals: cycle1,
    archivedCredentialProbes: archivedCredentialProbes(target.credentials),
    objectTransport: versionStore.restoreTransport({ targetBucket: target.resourceIds.artifactBucket, targetKmsKeyId: target.resourceIds.kmsKeyArn }),
    afterObjectRestored: completed => { if (completed === 1) { interrupted = true; throw new Error('forced object reconciliation interruption') } },
  }), /forced object reconciliation interruption/)
  assert.equal(interrupted, true)
  assert.equal(versionStore.copyCount, 1)

  const completed1 = await finalizeRestoredBackup({
    receipt: receipt1,
    receiptSigningKey: signingKey,
    manifestBytes: backup.manifestBytes,
    manifestCustody: backup.manifestCustody,
    normalBaseUri: normal1.normalBaseUri,
    target: target.targetIdentity,
    principals: cycle1,
    archivedCredentialProbes: archivedCredentialProbes(target.credentials),
    objectTransport: versionStore.restoreTransport({ targetBucket: target.resourceIds.artifactBucket, targetKmsKeyId: target.resourceIds.kmsKeyArn }),
  })
  assert.equal(completed1.redispatchCount, 0)
  assert.equal(completed1.readyObjectVersions, 2)
  assert.equal(completed1.degradedObjectVersions, 1)
  assert.equal(new Set(completed1.degraded.map(value => `${value.objectKey}\0${value.versionId}`)).size, 1)
  assert.equal(versionStore.copyCount, 2)
  const firstCycleClient = new MongoClient(credentialUris(cycle1).runtime)
  await firstCycleClient.connect()
  assert.equal(await firstCycleClient.db(target.databaseName).listCollections({ name: 'stale_pre_restore' }, { nameOnly: true }).hasNext(), false)
  await firstCycleClient.close()
  for (const uri of Object.values(targetInitialCredentialUris)) await assertAuthDenied(uri)
  const terminalReplay = await finalizeRestoredBackup({
    receipt: receipt1,
    receiptSigningKey: signingKey,
    manifestBytes: backup.manifestBytes,
    manifestCustody: backup.manifestCustody,
    normalBaseUri: normal1.normalBaseUri,
    target: target.targetIdentity,
    principals: cycle1,
    archivedCredentialProbes: archivedCredentialProbes(target.credentials),
    objectTransport: versionStore.restoreTransport({ targetBucket: target.resourceIds.artifactBucket, targetKmsKeyId: target.resourceIds.kmsKeyArn }),
  })
  assert.equal(terminalReplay.stateSha256, completed1.stateSha256)
  assert.equal(versionStore.copyCount, 2)
  result.checks.push('interrupted-object-reconciliation-resumes-without-duplicate-version-or-redispatch')

  const cycle1Uris = credentialUris(cycle1)
  const cycle1Credentials = Object.fromEntries(cycle1.map(value => [value.kind, { username: value.username, password: value.newPassword }]))
  const cycle2 = principalSet(2)
  const completed2 = await restoreReplicaSetBackup({
    manifestBytes: backup.manifestBytes,
    manifestCustody: backup.manifestCustody,
    archiveCustody: backup.manifest.archive.custody,
    localArchivePath: backup.transientArchivePath,
    mongorestorePath: tools.mongorestorePath,
    target: target.targetIdentity,
    principals: cycle2,
    archivedCredentialProbes: archivedCredentialProbes(cycle1Credentials),
    maintenanceController: target.maintenanceController,
    receiptSigningKey: signingKey,
    objectTransport: versionStore.restoreTransport({ targetBucket: target.resourceIds.artifactBucket, targetKmsKeyId: target.resourceIds.kmsKeyArn }),
    requireVersionedObjectCustody: false,
  })
  assert.equal(completed2.redispatchCount, 0)
  assert.equal(versionStore.copyCount, 2)
  for (const uri of Object.values(cycle1Uris)) await assertAuthDenied(uri)
  result.checks.push('repeated-offline-restore-rotates-three-principals-and-retires-prior-cycle')

  const inventorySession = await target.maintenanceController.enter(target.targetIdentity)
  const inventoryClient = new MongoClient(inventorySession.noAuthUri)
  await inventoryClient.connect()
  const finalUsers = (await inventoryClient.db('admin').command({ usersInfo: { forAllDBs: true }, showPrivileges: false })).users
  assert.deepEqual(finalUsers.map(value => `${value.db}/${value.user}`).sort(), [`admin/agent_backup`, `admin/agent_migration`, `${target.databaseName}/agent_runtime`].sort())
  const finalRoles = (await inventoryClient.db('admin').command({ rolesInfo: 1, showBuiltinRoles: false, showPrivileges: true })).roles
  assert.equal(finalRoles.length, 1)
  assert.equal(finalRoles[0].role, 'agentMigration_restore_2')
  assert.deepEqual(finalRoles[0].privileges, [{ resource: { cluster: true }, actions: ['getParameter'] }])
  assert.deepEqual(finalRoles[0].roles.map(value => `${value.db}/${value.role}`).sort(), [`${target.databaseName}/dbAdmin`, `${target.databaseName}/readWrite`].sort())
  const dangerous = new Set(['anyAction', 'root', 'userAdmin', 'userAdminAnyDatabase'])
  assert.equal(finalUsers.some(user => user.roles.some(role => dangerous.has(role.role))), false)
  assert.equal(finalRoles.some(role => role.privileges.some(privilege => privilege.actions.some(action => dangerous.has(action)))), false)
  await inventoryClient.close()
  await inventorySession.close()
  result.checks.push('stale-target-removal-exact-three-principals-and-single-narrow-role')

  const cycle2Uris = credentialUris(cycle2)
  const restoredClient = new MongoClient(cycle2Uris.runtime)
  await restoredClient.connect()
  const restoredDb = restoredClient.db(target.databaseName)
  assert.equal(await restoredDb.collection('dispatch_intents').countDocuments({}), 1)
  assert.equal(await restoredDb.collection('audit_events').countDocuments({ eventType: 'executor.launch' }), 1)
  assert.equal(await restoredDb.collection('wakes').countDocuments({ state: 'queued', recoveryMode: 'restored_observation', dispatchAllowed: false }), 1)
  assert.equal(await restoredDb.collection('artifact_versions').countDocuments({ state: 'ready' }), 2)
  assert.equal(await restoredDb.collection('artifact_versions').countDocuments({ state: 'degraded_missing_object' }), 1)

  const postArchive = join(temporary, 'post-restore.archive.gz')
  const postQuiesceProof = { schemaVersion: '1.0', proofId: 'aqp_post_restore_001', sourceEnvironment: 'restore-val12', apiDesiredCount: 0, apiRunningCount: 0, observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString(), sourceResourceIds: target.resourceIds }
  const postBackup = await createReplicaSetBackup({
    db: restoredDb,
    backupUri: cycle2Uris.backup,
    mongodumpPath: tools.mongodumpPath,
    archivePath: postArchive,
    sourceEnvironment: 'restore-val12',
    sourceDatabase: target.databaseName,
    sourceResourceIds: target.resourceIds,
    sourceSecretVersionIds: { runtime: 'target-runtime-version-002', migration: 'target-migration-version-002', backup: 'target-backup-version-002' },
    sourceResourceIdentityProbe: { inspect: async () => target.resourceIds },
    admissionQuiesceProof: postQuiesceProof,
    admissionQuiesceProbe: { inspect: async () => postQuiesceProof },
    objects: completed2.objectVersionMappings.map(value => value.target),
    custodyMode: 'local_evidence',
    publishArchive: versionStore.publishArchive({ bucket: target.resourceIds.backupBucket, objectKey: 'daily/post-restore.archive.gz', kmsKeyId: target.resourceIds.kmsKeyArn }),
    publishManifest: versionStore.publishManifest({ bucket: target.resourceIds.backupBucket, objectKey: 'daily/post-restore.manifest.json', kmsKeyId: target.resourceIds.kmsKeyArn }),
  })
  assert.equal(postBackup.manifest.sourceDatabase, target.databaseName)
  await restoredClient.close()
  result.checks.push('post-restore-backup-and-observation-only-state')

  finalOutput = {
    ...result,
    ok: true,
    copyCount: versionStore.copyCount,
    readyObjectVersions: completed2.readyObjectVersions,
    degradedObjectVersions: completed2.degradedObjectVersions,
    redispatchCount: completed2.redispatchCount,
    specialCharacterCredentialCorpus: ['percent', 'slash', 'hash', 'at', 'plus', 'space'],
  }
} finally {
  await target.stop().catch(() => undefined)
  await source.stop().catch(() => undefined)
  rmSync(temporary, { recursive: true, force: true })
  assert.deepEqual(captureProtectedMongoListener(), protectedListenerBefore, 'protected MongoDB listener changed during backup/restore cleanup')
}
if (finalOutput) console.log(JSON.stringify({ ...finalOutput, protectedDefaultListenerUnchanged: true }, null, 2))

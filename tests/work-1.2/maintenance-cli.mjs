import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { FakeVersionedS3 } from '../fixtures/work-1.2/fake-versioned-s3.mjs'
import { FakeEcsAdmissionService } from '../fixtures/work-1.2/fake-ecs-admission.mjs'
import { captureProtectedMongoListener, resolveMongoTools, startAuthenticatedReplica } from '../fixtures/work-1.2/mongo-replica.mjs'
import { internalMaintenanceCli } from '../../packages/storage/lib/maintenance-cli.js'
import { openAgentStorage, parseBackupManifestBytes } from '../../packages/storage/lib/index.js'

const storageRequire = createRequire(new URL('../../packages/storage/package.json', import.meta.url))
const { MongoClient } = storageRequire('mongodb')
const temporary = mkdtempSync(join(tmpdir(), 'agent-work-1.2-cli-'))
const protectedBefore = captureProtectedMongoListener()
const s3 = new FakeVersionedS3()
await s3.start()
const ecsClusterArn = 'arn:aws:ecs:us-east-1:123456789012:cluster/stokd-agent-api-test-cli-source'
const ecsServiceArn = 'arn:aws:ecs:us-east-1:123456789012:service/stokd-agent-api-test-cli-source/stokd-agent-api-test-cli-source'
const ecs = new FakeEcsAdmissionService({ clusterArn: ecsClusterArn, serviceArn: ecsServiceArn })
await ecs.start()
const tools = resolveMongoTools()
const sourceCredentials = {
  runtimePassword: 'CliSrc% /#@+ space runtime 1234',
  backupPassword: 'CliSrc% /#@+ space backup 12345',
  migrationPassword: 'CliSrc% /#@+ space migration 12',
}
const source = await startAuthenticatedReplica({
  environment: 'test-cli-source',
  temporaryParent: temporary,
  principalCredentials: {
    runtime: { username: 'agent_runtime', password: sourceCredentials.runtimePassword },
    migration: { username: 'agent_migration', password: sourceCredentials.migrationPassword },
    backup: { username: 'agent_backup', password: sourceCredentials.backupPassword },
  },
})
const target = await startAuthenticatedReplica({ environment: 'restore-cli12', temporaryParent: temporary })
const cliPath = new URL('../../packages/storage/lib/maintenance-cli.js', import.meta.url).pathname
const configTexts = []
const processOutputs = []
let finalOutput = null

const writeCanonical = (path, value, mode = 0o400) => {
  writeFileSync(path, JSON.stringify(value), { mode })
  chmodSync(path, mode)
  return path
}
const commandEnv = extra => {
  const env = { ...process.env, ...extra,
    AWS_ENDPOINT_URL_S3: s3.endpoint,
    AWS_ENDPOINT_URL_ECS: ecs.endpoint,
    AWS_ACCESS_KEY_ID: 'fixture-access-key',
    AWS_SECRET_ACCESS_KEY: 'fixture-secret-key',
    AWS_EC2_METADATA_DISABLED: 'true',
    NODE_OPTIONS: '',
    NODE_PATH: '',
  }
  delete env.AWS_PROFILE
  delete env.AWS_CONFIG_FILE
  return env
}
const startCli = ({ command, configPath, credentialPath, outputPath, hmacPath }) => {
  const child = spawn(process.execPath, [cliPath, command], {
    cwd: new URL('../..', import.meta.url),
    env: commandEnv({
      AGENT_MAINTENANCE_CONFIG: configPath,
      AGENT_CREDENTIAL_FILE: credentialPath,
      AGENT_OUTPUT_PATH: outputPath,
      ...(hmacPath ? { AGENT_RECEIPT_HMAC_KEY_FILE: hmacPath } : {}),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', value => { stdout += value })
  child.stderr.on('data', value => { stderr += value })
  const completed = new Promise(resolve => child.once('exit', (code, signal) => {
    processOutputs.push(stdout, stderr)
    resolve({ code, signal, stdout, stderr })
  }))
  return { child, completed }
}
const runCli = async input => startCli(input).completed
const assertSanitizedSuccess = (run, command, outputPath) => {
  assert.equal(run.code, 0, run.stderr)
  assert.equal(run.signal, null)
  assert.equal(run.stderr, '')
  assert.deepEqual(JSON.parse(run.stdout), { schemaVersion: '1.0', command, ok: true, outputWritten: true })
  assert.equal(statSync(outputPath).mode & 0o777, 0o600)
  assert.equal(readFileSync(outputPath, 'utf8'), JSON.stringify(JSON.parse(readFileSync(outputPath, 'utf8'))))
}
const fileSet = (prefix, config, credentials, configMode = 0o400, credentialMode = 0o400) => {
  configTexts.push(JSON.stringify(config))
  return {
    configPath: writeCanonical(join(temporary, `${prefix}.config.json`), config, configMode),
    credentialPath: writeCanonical(join(temporary, `${prefix}.credentials.json`), credentials, credentialMode),
    outputPath: join(temporary, `${prefix}.output.json`),
  }
}
const readEnvelope = path => JSON.parse(readFileSync(path, 'utf8'))
const targetPrincipals = {
  runtimePassword: 'CliNew% /#@+ space runtime 1234',
  migrationPassword: 'CliNew% /#@+ space migration 12',
  backupPassword: 'CliNew% /#@+ space backup 12345',
}
const encode = encodeURIComponent
const targetRuntimeUri = `mongodb://agent_runtime:${encode(targetPrincipals.runtimePassword)}@${target.address}/${target.databaseName}?authSource=${target.databaseName}&replicaSet=${target.replicaSet}`

try {
  const migrateFiles = fileSet('migrate', {
    schemaVersion: '1.0', command: 'migrate', environment: 'test-cli-source', databaseName: source.databaseName, replicaSet: source.replicaSet, mongoHost: source.address,
  }, { migrationPassword: sourceCredentials.migrationPassword })
  const migrateRun = await runCli({ command: 'migrate', ...migrateFiles })
  assertSanitizedSuccess(migrateRun, 'migrate', migrateFiles.outputPath)
  const migrateReplayFiles = fileSet('migrate-replay', JSON.parse(readFileSync(migrateFiles.configPath, 'utf8')), { migrationPassword: sourceCredentials.migrationPassword })
  const migrateReplayRun = await runCli({ command: 'migrate', ...migrateReplayFiles })
  assertSanitizedSuccess(migrateReplayRun, 'migrate', migrateReplayFiles.outputPath)
  assert.equal(readEnvelope(migrateFiles.outputPath).result.schemaVersion, 1)
  assert.equal(readEnvelope(migrateReplayFiles.outputPath).result.schemaVersion, 1)
  assert.equal(readEnvelope(migrateReplayFiles.outputPath).result.migrationApplied, false)
  const sourceStorage = await openAgentStorage({ uri: source.runtimeUri, environment: 'test-cli-source', expectedReplicaSet: source.replicaSet, principal: 'runtime' })
  const now = new Date()
  const artifacts = [
    s3.put({ bucket: source.resourceIds.artifactBucket, objectKey: 'agents/a-first.bin', kmsKeyId: source.resourceIds.kmsKeyArn, bytes: Buffer.from('first cli object'), metadata: { sha256: createHash('sha256').update('first cli object').digest('hex') } }),
    s3.put({ bucket: source.resourceIds.artifactBucket, objectKey: 'agents/z-second.bin', kmsKeyId: source.resourceIds.kmsKeyArn, bytes: Buffer.from('second cli object'), metadata: { sha256: createHash('sha256').update('second cli object').digest('hex') } }),
  ]
  await sourceStorage.db.collection('agents').insertOne({ agentId: 'agt_cli00001', ownerSubject: 'own_cli00001', normalizedName: 'cli-agent', state: 'active', createdAt: now })
  await sourceStorage.db.collection('wakes').insertOne({ wakeId: 'wak_cli00001', agentId: 'agt_cli00001', ingressSequence: 1, state: 'queued', queuedAt: now })
  await sourceStorage.db.collection('dispatch_intents').insertOne({ intentId: 'intent_cli00001', workId: 'wrk_cli00001', workAttemptGeneration: 1, intentHash: 'cli-intent', state: 'accepted' })
  for (const [index, custody] of artifacts.entries()) {
    await sourceStorage.db.collection('artifact_versions').insertOne({
      versionId: `arv_cli0000${index + 1}`, artifactId: `art_cli0000${index + 1}`, ordinal: 1, agentId: 'agt_cli00001', state: 'ready', createdAt: now,
      bucket: custody.bucket, objectKey: custody.objectKey, s3VersionId: custody.versionId, eTag: custody.eTag, sha256: custody.sha256,
      byteLength: custody.byteLength, kmsKeyId: custody.kmsKeyId, custodyCapturedAt: new Date(custody.capturedAt),
    })
  }
  await sourceStorage.close()

  const readinessFiles = fileSet('readiness', {
    schemaVersion: '1.0', command: 'readiness', environment: 'test-cli-source', databaseName: source.databaseName, replicaSet: source.replicaSet, mongoHost: source.address,
  }, { runtimePassword: sourceCredentials.runtimePassword })
  const readinessRun = await runCli({ command: 'readiness', ...readinessFiles })
  assertSanitizedSuccess(readinessRun, 'readiness', readinessFiles.outputPath)

  const validationPayload = Buffer.from('0123456789abcdef0123456789abcdef')
  const validationPayloadPath = join(temporary, 'validation-payload.bin')
  writeFileSync(validationPayloadPath, validationPayload, { mode: 0o400 })
  chmodSync(validationPayloadPath, 0o400)
  const validationOperationId = 'valop_work12_durable_fixture'
  const validationRetainedArtifact = s3.put({
    bucket: source.resourceIds.artifactBucket,
    objectKey: `agents/validation/${validationOperationId}/retained.bin`,
    kmsKeyId: source.resourceIds.kmsKeyArn,
    bytes: validationPayload,
    metadata: { sha256: createHash('sha256').update(validationPayload).digest('hex') },
  })
  const validationAbsentArtifact = s3.put({
    bucket: source.resourceIds.artifactBucket,
    objectKey: `agents/validation/${validationOperationId}/absent-after-backup.bin`,
    kmsKeyId: source.resourceIds.kmsKeyArn,
    bytes: validationPayload,
    metadata: { sha256: createHash('sha256').update(validationPayload).digest('hex') },
  })
  const validationArtifactCustodyPath = writeCanonical(join(temporary, 'validation-artifact-custody.json'), {
    schemaVersion: '1.0',
    retained: validationRetainedArtifact,
    absentAfterBackup: validationAbsentArtifact,
  })
  const validationSeedConfig = {
    schemaVersion: '1.0', command: 'validation-seed', environment: 'test-cli-source', databaseName: source.databaseName, replicaSet: source.replicaSet, mongoHost: source.address,
    operationId: validationOperationId, payloadPath: validationPayloadPath, artifactCustodyPath: validationArtifactCustodyPath,
    sourceResourceIds: source.resourceIds, region: 'us-east-1',
  }
  const validationSeedFiles = fileSet('validation-seed', validationSeedConfig, { runtimePassword: sourceCredentials.runtimePassword })
  const validationSeedRun = await runCli({ command: 'validation-seed', ...validationSeedFiles })
  assertSanitizedSuccess(validationSeedRun, 'validation-seed', validationSeedFiles.outputPath)
  const validationReplayFiles = fileSet('validation-seed-replay', validationSeedConfig, { runtimePassword: sourceCredentials.runtimePassword })
  const validationReplayRun = await runCli({ command: 'validation-seed', ...validationReplayFiles })
  assertSanitizedSuccess(validationReplayRun, 'validation-seed', validationReplayFiles.outputPath)
  assert.deepEqual(readEnvelope(validationReplayFiles.outputPath).result, readEnvelope(validationSeedFiles.outputPath).result)
  const validationReadFiles = fileSet('validation-read', {
    schemaVersion: '1.0', command: 'validation-read', environment: 'test-cli-source', databaseName: source.databaseName, replicaSet: source.replicaSet, mongoHost: source.address,
    operationId: validationOperationId, expectedPayloadSha256: createHash('sha256').update(validationPayload).digest('hex'),
  }, { runtimePassword: sourceCredentials.runtimePassword })
  const validationReadRun = await runCli({ command: 'validation-read', ...validationReadFiles })
  assertSanitizedSuccess(validationReadRun, 'validation-read', validationReadFiles.outputPath)
  assert.deepEqual(readEnvelope(validationReadFiles.outputPath).result, readEnvelope(validationSeedFiles.outputPath).result)
  const sourceValidationReceipt = readEnvelope(validationReadFiles.outputPath).result
  assert.equal(sourceValidationReceipt.recoveryMode, 'live')
  assert.equal(sourceValidationReceipt.pending.dispatchAllowed, true)
  assert.equal(sourceValidationReceipt.dispatchIntentCount, 1)
  assert.equal(sourceValidationReceipt.executorLaunchCount, 1)
  assert.equal(sourceValidationReceipt.artifacts[0].kind, 'retained')
  assert.equal(sourceValidationReceipt.artifacts[0].state, 'ready')
  assert.equal(sourceValidationReceipt.artifacts[0].versionMapped, false)
  assert.equal(sourceValidationReceipt.artifacts[1].kind, 'absent_after_backup')
  assert.equal(sourceValidationReceipt.artifacts[1].state, 'ready')
  assert.equal(sourceValidationReceipt.artifacts[1].degradedReason, undefined)
  assert.equal(sourceValidationReceipt.redispatchCount, 0)
  const conflictingPayloadPath = join(temporary, 'validation-payload-conflict.bin')
  writeFileSync(conflictingPayloadPath, Buffer.alloc(32, 0x78), { mode: 0o400 })
  chmodSync(conflictingPayloadPath, 0o400)
  const validationConflictFiles = fileSet('validation-seed-conflict', { ...validationSeedConfig, payloadPath: conflictingPayloadPath }, { runtimePassword: sourceCredentials.runtimePassword })
  const validationConflictRun = await runCli({ command: 'validation-seed', ...validationConflictFiles })
  assert.equal(validationConflictRun.code, 1)
  assert.equal(existsSync(validationConflictFiles.outputPath), false)

  const sourceProofPath = writeCanonical(join(temporary, 'source-resource-proof.json'), source.resourceIds)
  const admissionQuiesceProof = { schemaVersion: '1.0', proofId: 'aqp_cli_backup_001', sourceEnvironment: 'test-cli-source', apiDesiredCount: 0, apiRunningCount: 0, observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString(), sourceResourceIds: source.resourceIds }
  const admissionQuiesceProofPath = writeCanonical(join(temporary, 'admission-quiesce-proof.json'), admissionQuiesceProof)
  const backupFiles = fileSet('backup', {
    schemaVersion: '1.0', command: 'backup', environment: 'test-cli-source', databaseName: source.databaseName, replicaSet: source.replicaSet,
    mongoHost: source.address, mongodumpPath: tools.mongodumpPath, workDirectory: join(temporary, 'backup-work'), sourceResourceIds: source.resourceIds,
    sourceSecretVersionIds: { runtime: 'source-runtime-version-001', migration: 'source-migration-version-001', backup: 'source-backup-version-001' },
    sourceResourceProofPath: sourceProofPath, admissionQuiesceProofPath,
    admissionQuiesceProbe: { kind: 'ecs-describe-service', clusterArn: ecsClusterArn, serviceArn: ecsServiceArn }, region: 'us-east-1',
    archiveObject: { bucket: source.resourceIds.backupBucket, key: 'daily/agent.archive.gz', kmsKeyArn: source.resourceIds.kmsKeyArn },
    manifestObject: { bucket: source.resourceIds.backupBucket, key: 'daily/agent.manifest.json', kmsKeyArn: source.resourceIds.kmsKeyArn },
  }, { runtimePassword: sourceCredentials.runtimePassword, backupPassword: sourceCredentials.backupPassword })
  const baseBackupConfig = JSON.parse(readFileSync(backupFiles.configPath, 'utf8'))
  const invalidEcsProbes = [
    { ...baseBackupConfig.admissionQuiesceProbe, serviceArn: baseBackupConfig.admissionQuiesceProbe.serviceArn.replace('123456789012', '999999999999') },
    { ...baseBackupConfig.admissionQuiesceProbe, clusterArn: baseBackupConfig.admissionQuiesceProbe.clusterArn.replace(':us-east-1:', ':us-west-2:'), serviceArn: baseBackupConfig.admissionQuiesceProbe.serviceArn.replace(':us-east-1:', ':us-west-2:') },
    { ...baseBackupConfig.admissionQuiesceProbe, serviceArn: baseBackupConfig.admissionQuiesceProbe.serviceArn.replace(/[^/]+$/, 'other-service') },
  ]
  for (const [index, admissionQuiesceProbe] of invalidEcsProbes.entries()) {
    const invalidFiles = fileSet(`backup-invalid-ecs-${index}`, { ...baseBackupConfig, admissionQuiesceProbe }, { runtimePassword: sourceCredentials.runtimePassword, backupPassword: sourceCredentials.backupPassword })
    const invalidRun = await runCli({ command: 'backup', ...invalidFiles })
    assert.equal(invalidRun.code, 2)
    assert.equal(existsSync(invalidFiles.outputPath), false)
  }
  const backupRun = await runCli({ command: 'backup', ...backupFiles })
  assertSanitizedSuccess(backupRun, 'backup', backupFiles.outputPath)
  const backupEnvelope = readEnvelope(backupFiles.outputPath)
  const manifestCustody = backupEnvelope.result.manifestCustody
  const archiveCustody = backupEnvelope.result.archiveCustody
  const manifestPath = join(temporary, 'downloaded.manifest.json')
  const archivePath = join(temporary, 'downloaded.archive.gz')
  writeFileSync(manifestPath, s3.bytes(manifestCustody), { mode: 0o400 })
  writeFileSync(archivePath, s3.bytes(archiveCustody), { mode: 0o400 })
  chmodSync(manifestPath, 0o400)
  chmodSync(archivePath, 0o400)
  const manifest = parseBackupManifestBytes(readFileSync(manifestPath))
  assert.equal(manifest.objects.length, 4)
  assert.equal(manifest.objects.some(record => record.versionId === validationRetainedArtifact.versionId), true)
  assert.equal(manifest.objects.some(record => record.versionId === validationAbsentArtifact.versionId), true)
  assert.deepEqual(manifest.sourceSecretVersionIds, { runtime: 'source-runtime-version-001', migration: 'source-migration-version-001', backup: 'source-backup-version-001' })
  assert.equal(ecs.describeCount, 2)
  assert.ok(s3.exact(validationAbsentArtifact), 'the retained-custody policy keeps the injected-missing source version immutable')

  const driftConfig = {
    ...JSON.parse(readFileSync(backupFiles.configPath, 'utf8')),
    archiveObject: { bucket: source.resourceIds.backupBucket, key: 'drift/agent.archive.gz', kmsKeyArn: source.resourceIds.kmsKeyArn },
    manifestObject: { bucket: source.resourceIds.backupBucket, key: 'drift/agent.manifest.json', kmsKeyArn: source.resourceIds.kmsKeyArn },
  }
  const driftFiles = fileSet('backup-admission-drift', driftConfig, { runtimePassword: sourceCredentials.runtimePassword, backupPassword: sourceCredentials.backupPassword })
  ecs.setDriftAtCall(ecs.describeCount + 2)
  const driftRun = await runCli({ command: 'backup', ...driftFiles })
  assert.equal(driftRun.code, 1)
  assert.equal(existsSync(driftFiles.outputPath), false)
  assert.equal(s3.rows(source.resourceIds.backupBucket, 'drift/agent.archive.gz').length, 0)
  assert.equal(s3.rows(source.resourceIds.backupBucket, 'drift/agent.manifest.json').length, 0)
  ecs.setDriftAtCall(null)

  const hmacPath = join(temporary, 'receipt.hmac')
  writeFileSync(hmacPath, randomBytes(32), { mode: 0o400 })
  chmodSync(hmacPath, 0o400)
  const maintenance = await target.maintenanceController.enter(target.targetIdentity)
  const { sessionToken, ...publicProof } = maintenance.proof
  const targetSecretVersionIds = { runtime: 'cli-runtime-version-001', migration: 'cli-migration-version-001', backup: 'cli-backup-version-001' }
  const offlineFiles = fileSet('restore-offline', {
    schemaVersion: '1.0', command: 'restore-offline', manifestPath, manifestCustody, archiveCustody, localArchivePath: archivePath,
    mongorestorePath: tools.mongorestorePath, target: target.targetIdentity, noAuthUri: maintenance.noAuthUri, maintenanceProof: publicProof,
    migrationRoleName: 'agentMigration_restore_cli', targetSecretVersionIds, requireVersionedObjectCustody: true,
  }, { ...targetPrincipals, maintenanceSessionToken: sessionToken })
  const offlineRun = await runCli({ command: 'restore-offline', ...offlineFiles, hmacPath })
  assertSanitizedSuccess(offlineRun, 'restore-offline', offlineFiles.outputPath)
  const normal = await maintenance.enableAuth()
  await maintenance.close()

  const finalizeConfig = {
    schemaVersion: '1.0', command: 'restore-finalize', manifestPath, manifestCustody, offlineReceiptPath: offlineFiles.outputPath,
    normalMongoHost: target.address, target: target.targetIdentity, migrationRoleName: 'agentMigration_restore_cli', targetSecretVersionIds,
    sourceSecretVersionIds: manifest.sourceSecretVersionIds, region: 'us-east-1',
    targetArtifactBucket: target.resourceIds.artifactBucket, targetArtifactKmsKeyArn: target.resourceIds.kmsKeyArn,
    work12InjectedObjectFailure: {
      kind: 'injected_missing_version',
      operationId: validationOperationId,
      custody: validationAbsentArtifact,
    },
  }
  const finalizeCredentials = {
    ...targetPrincipals,
    sourceRuntimePassword: sourceCredentials.runtimePassword,
    sourceMigrationPassword: sourceCredentials.migrationPassword,
    sourceBackupPassword: sourceCredentials.backupPassword,
    priorRuntimePassword: target.credentials.runtime.password,
    priorMigrationPassword: target.credentials.migration.password,
    priorBackupPassword: target.credentials.backup.password,
  }
  const finalizeFiles = fileSet('restore-finalize', finalizeConfig, finalizeCredentials)
  const gate = s3.blockNextCopy(validationRetainedArtifact.objectKey)
  const interrupted = startCli({ command: 'restore-finalize', ...finalizeFiles, hmacPath })
  await Promise.race([gate.entered, new Promise((_, reject) => setTimeout(() => reject(new Error('second S3 copy was not reached')), 30_000))])
  assert.ok(interrupted.child.pid > 1)
  interrupted.child.kill('SIGKILL')
  gate.release(false)
  const interruptedRun = await interrupted.completed
  assert.equal(interruptedRun.signal, 'SIGKILL')
  assert.equal(existsSync(finalizeFiles.outputPath), false)
  assert.equal(s3.copyCount, 1)

  const recoveryClient = new MongoClient(targetRuntimeUri)
  await recoveryClient.connect()
  const recoveryDb = recoveryClient.db(target.databaseName)
  const running = await recoveryDb.collection('restore_reconciliations').findOne({ state: 'restoring' })
  assert.equal(running.objectVersionMappings.length, 1)
  await recoveryDb.collection('restore_reconciliations').updateOne({ _id: running._id, state: 'restoring' }, { $set: { leaseExpiresAt: new Date(0) } })
  await recoveryClient.close()

  const retryRun = await runCli({ command: 'restore-finalize', ...finalizeFiles, hmacPath })
  assertSanitizedSuccess(retryRun, 'restore-finalize', finalizeFiles.outputPath)
  assert.equal(s3.copyCount, 3)
  const finalizeEnvelope = readEnvelope(finalizeFiles.outputPath)
  assert.equal(finalizeEnvelope.result.redispatchCount, 0)
  assert.equal(finalizeEnvelope.result.readyObjectVersions, 3)
  assert.equal(finalizeEnvelope.result.degradedObjectVersions, 1)
  assert.deepEqual(finalizeEnvelope.result.degraded.find(value => value.objectKey === validationAbsentArtifact.objectKey), {
    objectKey: validationAbsentArtifact.objectKey,
    versionId: validationAbsentArtifact.versionId,
    reason: 'missing_version',
    provenance: 'work12_injected_missing_version_after_exact_source_head',
  })
  assert.ok(s3.exact(validationAbsentArtifact), 'injected degradation must leave the exact AWS-style source version present')
  assert.deepEqual(finalizeEnvelope.result.dispatchBoundaryBefore.accepted, 2)
  assert.deepEqual(finalizeEnvelope.result.dispatchBoundaryAfter.accepted, 2)
  assert.deepEqual(finalizeEnvelope.result.dispatchBoundaryBefore.launched, 1)
  assert.deepEqual(finalizeEnvelope.result.dispatchBoundaryAfter.launched, 1)
  assert.equal(finalizeEnvelope.result.credentialRotation.archivedCredentialProbeResults.length, 6)
  for (const record of artifacts) {
    const sourceBinding = createHash('sha256').update(record.bucket).update('\0').update(record.objectKey).update('\0').update(record.versionId).digest('hex')
    assert.equal(s3.matchingTargetCopies(target.resourceIds.artifactBucket, record.objectKey, sourceBinding).length, 1)
  }
  const restoredValidationFiles = fileSet('validation-read-restored', {
    schemaVersion: '1.0', command: 'validation-read', environment: 'restore-cli12', databaseName: target.databaseName, replicaSet: target.replicaSet, mongoHost: target.address,
    operationId: validationOperationId, expectedPayloadSha256: createHash('sha256').update(validationPayload).digest('hex'),
  }, { runtimePassword: targetPrincipals.runtimePassword })
  const restoredValidationRun = await runCli({ command: 'validation-read', ...restoredValidationFiles })
  assertSanitizedSuccess(restoredValidationRun, 'validation-read', restoredValidationFiles.outputPath)
  const restoredValidationReceipt = readEnvelope(restoredValidationFiles.outputPath).result
  assert.equal(restoredValidationReceipt.semanticStateSha256, sourceValidationReceipt.semanticStateSha256)
  assert.equal(restoredValidationReceipt.recoveryMode, 'restored_observation')
  assert.equal(restoredValidationReceipt.pending.dispatchAllowed, false)
  assert.equal(restoredValidationReceipt.dispatchIntentCount, 1)
  assert.equal(restoredValidationReceipt.executorLaunchCount, 1)
  assert.equal(restoredValidationReceipt.artifacts[0].sourceS3VersionId, sourceValidationReceipt.artifacts[0].sourceS3VersionId)
  assert.notEqual(restoredValidationReceipt.artifacts[0].currentS3VersionId, sourceValidationReceipt.artifacts[0].currentS3VersionId)
  assert.equal(restoredValidationReceipt.artifacts[0].currentBucket, target.resourceIds.artifactBucket)
  assert.equal(restoredValidationReceipt.artifacts[0].versionMapped, true)
  assert.equal(restoredValidationReceipt.artifacts[1].sourceS3VersionId, sourceValidationReceipt.artifacts[1].sourceS3VersionId)
  assert.equal(restoredValidationReceipt.artifacts[1].currentS3VersionId, sourceValidationReceipt.artifacts[1].currentS3VersionId)
  assert.equal(restoredValidationReceipt.artifacts[1].state, 'degraded_missing_object')
  assert.equal(restoredValidationReceipt.artifacts[1].degradedReason, 'missing_version')
  assert.equal(restoredValidationReceipt.artifacts[1].degradationProvenance, 'work12_injected_missing_version_after_exact_source_head')
  assert.equal(restoredValidationReceipt.artifacts[1].versionMapped, false)
  assert.equal(restoredValidationReceipt.redispatchCount, 0)

  const badConfig = fileSet('bad-config-mode', { schemaVersion: '1.0', command: 'readiness' }, { runtimePassword: 'irrelevant-secret' }, 0o600)
  const badConfigRun = await runCli({ command: 'readiness', ...badConfig })
  assert.equal(badConfigRun.code, 2)
  assert.deepEqual(JSON.parse(badConfigRun.stderr).error, { code: 'invalid_storage_config', message: 'Agent storage maintenance command failed' })
  const badCredential = fileSet('bad-credential-mode', readinessFiles ? { schemaVersion: '1.0', command: 'readiness', environment: 'test-cli-source', databaseName: source.databaseName, replicaSet: source.replicaSet, mongoHost: source.address } : {}, { runtimePassword: sourceCredentials.runtimePassword }, 0o400, 0o600)
  const badCredentialRun = await runCli({ command: 'readiness', ...badCredential })
  assert.equal(badCredentialRun.code, 2)
  const badHmacPath = join(temporary, 'bad-hmac')
  writeFileSync(badHmacPath, randomBytes(32), { mode: 0o600 })
  const hmacModeFiles = fileSet('bad-hmac-mode', { schemaVersion: '1.0', command: 'restore-offline' }, {})
  const badHmacRun = await runCli({ command: 'restore-offline', ...hmacModeFiles, hmacPath: badHmacPath })
  assert.equal(badHmacRun.code, 2)
  assert.doesNotThrow(() => internalMaintenanceCli.readOwnerReadOnlyBytes(readinessFiles.configPath, 'real owned input fixture'))
  assert.doesNotThrow(() => internalMaintenanceCli.readOwnedOutputJson(readinessFiles.outputPath, 'real owned output fixture'))
  const foreignStat = mode => ({ uid: process.geteuid() + 1, mode, isFile: () => true })
  assert.throws(() => internalMaintenanceCli.assertFileOwnership(foreignStat(0o100400), process.geteuid(), 'foreign 0400 fixture', 0o400), error => error?.code === 'invalid_storage_config' && /owner-controlled/.test(error.message))
  assert.throws(() => internalMaintenanceCli.assertFileOwnership(foreignStat(0o100600), process.geteuid(), 'foreign 0600 fixture', 0o600), error => error?.code === 'invalid_storage_config' && /owner-controlled/.test(error.message))

  const secretValues = [
    ...Object.values(sourceCredentials), ...Object.values(targetPrincipals), ...Object.values(target.credentials).map(value => value.password), sessionToken,
    'fixture-secret-key', 'irrelevant-secret',
  ]
  const forbidden = secretValues.flatMap((secret, secretIndex) => [
    { secretIndex, variant: 'raw', value: secret },
    { secretIndex, variant: 'uri', value: encodeURIComponent(secret) },
    { secretIndex, variant: 'sha256', value: createHash('sha256').update(secret).digest('hex') },
  ])
  const publicBlobs = [...configTexts, ...processOutputs, ...[readinessFiles.outputPath, validationSeedFiles.outputPath, validationReadFiles.outputPath, restoredValidationFiles.outputPath, backupFiles.outputPath, offlineFiles.outputPath, finalizeFiles.outputPath].map(path => readFileSync(path, 'utf8'))]
  for (const [blobIndex, blob] of publicBlobs.entries()) for (const item of forbidden) assert.equal(blob.includes(item.value), false, `secret ${item.secretIndex} ${item.variant} escaped into public blob ${blobIndex}`)
  assert.equal(readdirSync(temporary).some(name => name.endsWith('.tmp')), false)

  finalOutput = {
    schemaVersion: '1.0',
    ok: true,
    commands: ['migrate', 'readiness', 'validation-seed', 'validation-read', 'backup', 'restore-offline', 'restore-finalize'],
    migrationReplay: 'idempotent',
    validationFixtureReplay: 'representative-state-idempotent-conflict-safe-and-version-mapped',
    interruptedFinalizeSignal: 'SIGKILL',
    copiedVersions: s3.copyCount,
    injectedMissingVersionAfterExactSourceHead: true,
    injectedSourceVersionRetained: true,
    redispatchCount: 0,
    inputModes: '0400-owner',
    outputMode: '0600-atomic',
    foreignOwnerRejected: true,
    secretRedaction: { raw: true, uriEncoded: true, credentialSha256: true },
    specialCharacterCredentialCorpus: ['percent', 'slash', 'hash', 'at', 'plus', 'space'],
  }
} finally {
  await target.stop().catch(() => undefined)
  await source.stop().catch(() => undefined)
  await s3.stop().catch(() => undefined)
  await ecs.stop().catch(() => undefined)
  rmSync(temporary, { recursive: true, force: true })
  assert.deepEqual(captureProtectedMongoListener(), protectedBefore, 'protected MongoDB listener changed during CLI scenario cleanup')
}
if (finalOutput) console.log(JSON.stringify({ ...finalOutput, protectedDefaultListenerUnchanged: true }, null, 2))

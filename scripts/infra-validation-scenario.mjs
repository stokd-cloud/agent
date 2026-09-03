#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { assertBoundedDeploymentIdentity, parseCallerIdentity } from '../infra/shared/identity.mjs'
import { inspectAgentControlPlane } from './infra-control-plane-readback.mjs'
import { evidenceParameterName, readVersionedEvidence, writeVersionedEvidence } from './infra-evidence.mjs'
import { recordPhaseCompletion, work12Phases } from './infra-phase-control.mjs'
import { buildRestoreLockBinding, createOrResumeRestoreLock, releaseRestoreLock } from './infra-restore-lock.mjs'
import { assertValidationFixtureReceipt } from './infra-validation-fixture.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const accountId = '167217327520'
const region = 'us-east-1'
const fixtureOperationId = 'valop_work12_durable_fixture'
const fixturePayload = createHash('sha256').update('stokd-agent/cloud-agents-mvp/fixed-validation-fixture/v1').digest()
const fixturePayloadSha256 = createHash('sha256').update(fixturePayload).digest('hex')
const documentNames = {
  migrate: 'stokd-agent-migrate-host-v1',
  seed: 'stokd-agent-validation-seed-v1',
  backup: 'stokd-agent-validation-backup-v1',
  restore: 'stokd-agent-restore-host-v1',
}

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, env: process.env, encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${program} ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`)
  return (result.stdout ?? '').trim()
}
function aws(args) { return command('aws', [...args, '--region', region]) }
function parseJson(raw, name) {
  try { return JSON.parse(raw) }
  catch { throw new Error(`${name} returned invalid JSON`) }
}
function exactKeys(value, keys, name) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${name} has unexpected fields`)
}
function readParameter(name, required = true) {
  const result = spawnSync('aws', ['ssm', 'get-parameter', '--name', name, '--region', region, '--output', 'json'], { cwd: root, env: process.env, encoding: 'utf8' })
  if (result.status !== 0) {
    if (!required && /ParameterNotFound/.test(`${result.stderr}\n${result.stdout}`)) return undefined
    throw new Error(`required validation parameter ${name} is unavailable`)
  }
  const value = parseJson(result.stdout, `SSM parameter ${name}`).Parameter?.Value
  if (typeof value !== 'string') throw new Error(`SSM parameter ${name} omitted its value`)
  return parseJson(value, `SSM parameter ${name} value`)
}

function readEvidence(stage, kind, manifest) {
  return readVersionedEvidence({ aws, stage, kind, kmsKeyArn: manifest.custody.kmsKeyArn })
}
function writeEvidence(stage, kind, manifest, value) {
  return writeVersionedEvidence({ aws, stage, kind, kmsKeyArn: manifest.custody.kmsKeyArn, value })
}

function readDataManifest(stage) {
  const manifest = readParameter(`/stokd-agent/${stage}/infrastructure-manifest/v1`)
  if (manifest?.schemaVersion !== '1.0' || manifest?.manifestVersion !== 1 || manifest?.accountId !== accountId || manifest?.region !== region || manifest?.stage !== stage) throw new Error('data manifest identity is invalid')
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceDigest ?? '')) throw new Error('data manifest source digest is invalid')
  if (!manifest.vpc || manifest.vpc.natGatewayIds?.length !== 0 || manifest.vpc.elasticIpIds?.length !== 0) throw new Error('validation data manifest contains a NAT gateway or EIP')
  if (!/^vol-[a-f0-9]{17}$/.test(manifest.mongo?.volumeId ?? '') || !/^i-[a-f0-9]{17}$/.test(manifest.mongo?.instanceId ?? '')) throw new Error('Mongo physical identity is invalid')
  if (manifest.mongo?.host !== `mongo-${stage}.sst:27017` || manifest.mongo?.replicaSet !== 'agent-rs' || manifest.mongo?.databaseName !== `agent_${stage.replaceAll('-', '_')}`) throw new Error('Mongo Cloud Map identity is invalid')
  if (!/^srv-[a-z0-9]+$/.test(manifest.mongo?.discoveryServiceId ?? '') || manifest.mongo?.discoveryInstanceId !== `mongo-${stage}` || manifest.vpc?.cloudmapNamespaceName !== 'sst') throw new Error('Mongo Cloud Map custody is invalid')
  if (!/^arn:aws:kms:us-east-1:167217327520:key\/[a-f0-9-]{36}$/.test(manifest.custody?.kmsKeyArn ?? '')) throw new Error('KMS custody identity is invalid')
  if (manifest.custody?.artifactBucket !== `stokd-agent-artifacts-${stage}-${accountId}` || manifest.custody?.backupBucket !== `stokd-agent-backups-${stage}-${accountId}`) throw new Error('bucket custody identity is invalid')
  const expectedCluster = `arn:aws:ecs:${region}:${accountId}:cluster/stokd-agent-api-${stage}`
  const expectedService = `arn:aws:ecs:${region}:${accountId}:service/stokd-agent-api-${stage}/stokd-agent-api-${stage}`
  if (manifest.cluster?.arn !== expectedCluster || manifest.cluster?.serviceArn !== expectedService) throw new Error('ECS admission identity is invalid')
  return manifest
}

function currentApi(manifest) {
  const result = parseJson(aws(['ecs', 'describe-services', '--cluster', manifest.cluster.arn, '--services', manifest.cluster.serviceArn, '--output', 'json']), 'ECS service readback')
  if (result.failures?.length || result.services?.length !== 1) throw new Error('exact API service is unavailable')
  const service = result.services[0]
  if (service.clusterArn !== manifest.cluster.arn || service.serviceArn !== manifest.cluster.serviceArn || service.desiredCount !== 1 || service.runningCount !== 1 || !/^arn:aws:ecs:us-east-1:167217327520:task-definition\/stokd-agent-api-(source|restore)-val12:\d+$/.test(service.taskDefinition ?? '')) {
    throw new Error('API service is not at exact 1/1 readiness')
  }
  return { serviceArn: service.serviceArn, taskDefinitionArn: service.taskDefinition, desiredCount: 1, runningCount: 1 }
}

async function httpJson(url, expectedStatus = 200) {
  let last
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } })
      const body = await response.json()
      if (response.status === expectedStatus) return body
      last = new Error(`${url} returned ${response.status}`)
    } catch (error) { last = error }
    await new Promise(resolveWait => setTimeout(resolveWait, 5_000))
  }
  throw last ?? new Error(`${url} did not become ready`)
}

async function sendCommand(documentName, instanceId, parameters = {}) {
  if (!Object.values(documentNames).includes(documentName)) throw new Error('SSM document is not allowlisted')
  if (!/^i-[a-f0-9]{17}$/.test(instanceId)) throw new Error('SSM target instance is invalid')
  const args = ['ssm', 'send-command', '--document-name', documentName, '--instance-ids', instanceId, '--timeout-seconds', '7200', '--output', 'json']
  if (Object.keys(parameters).length) args.push('--parameters', JSON.stringify(Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, [value]]))))
  const sent = parseJson(aws(args), `SSM ${documentName} send`)
  const commandId = sent.Command?.CommandId
  if (!/^[a-f0-9-]{36}$/.test(commandId ?? '')) throw new Error('SSM omitted the exact command ID')
  let invocation
  for (let attempt = 0; attempt < 1440; attempt += 1) {
    const result = spawnSync('aws', ['ssm', 'get-command-invocation', '--command-id', commandId, '--instance-id', instanceId, '--region', region, '--output', 'json'], { cwd: root, env: process.env, encoding: 'utf8' })
    if (result.status === 0) {
      invocation = parseJson(result.stdout, `SSM ${documentName} invocation`)
      if (['Success', 'Failed', 'Cancelled', 'TimedOut', 'Cancelling'].includes(invocation.Status)) break
    } else if (!/InvocationDoesNotExist/.test(`${result.stderr}\n${result.stdout}`)) {
      throw new Error(`SSM ${documentName} readback failed`)
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 5_000))
  }
  if (invocation?.Status !== 'Success' || invocation.ResponseCode !== 0) throw new Error(`SSM ${documentName} failed closed with ${invocation?.Status ?? 'unknown status'}`)
  return { commandId, output: invocation.StandardOutputContent ?? '' }
}

function lastEnvelope(raw, expectedCommand) {
  const candidates = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const envelope = candidates.reverse().find(value => value?.schemaVersion === '1.0' && value?.command === expectedCommand && value?.ok === true && value?.result)
  if (!envelope) throw new Error(`host command omitted successful ${expectedCommand} evidence`)
  return envelope.result
}

function resourceIds(manifest) {
  return {
    artifactBucket: manifest.custody.artifactBucket,
    backupBucket: manifest.custody.backupBucket,
    databaseVolumeId: manifest.mongo.volumeId,
    kmsKeyArn: manifest.custody.kmsKeyArn,
    mongoInstanceId: manifest.mongo.instanceId,
  }
}
function assertFixtureReceipt(value, stage, artifactBucket, expectedSemanticStateSha256, currentKmsKeyArn) {
  return assertValidationFixtureReceipt({ value, stage, artifactBucket, expectedSemanticStateSha256, currentKmsKeyArn })
  /* c8 ignore start -- retained only as a reviewable historical shape while Work 1.2 closes */
  exactKeys(value, ['schemaVersion', 'operationId', 'payloadSha256', 'payloadByteLength', 'persistedAt', 'semanticStateSha256', 'identity', 'history', 'pending', 'priorExecution', 'artifacts', 'recoveryMode', 'dispatchIntentCount', 'executorLaunchCount', 'redispatchCount'], 'validation fixture receipt')
  assert.equal(value?.schemaVersion, '1.0')
  assert.equal(value?.operationId, fixtureOperationId)
  assert.equal(value?.payloadSha256, fixturePayloadSha256)
  assert.equal(value?.payloadByteLength, 32)
  assert.match(value?.semanticStateSha256 ?? '', /^[a-f0-9]{64}$/)
  assert.equal(new Date(value?.persistedAt ?? '').toISOString(), value.persistedAt)
  if (expectedSemanticStateSha256) assert.equal(value.semanticStateSha256, expectedSemanticStateSha256)
  exactKeys(value.identity, ['ownerSubject', 'agentId', 'normalizedName', 'profileRevision', 'profileSha256'], 'validation identity')
  assert.match(value?.identity?.ownerSubject ?? '', /^own_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value?.identity?.agentId ?? '', /^agt_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value?.identity?.normalizedName ?? '', /^validation-[a-f0-9]{24}$/)
  assert.equal(value?.identity?.profileRevision, 1)
  assert.match(value?.identity?.profileSha256 ?? '', /^[a-f0-9]{64}$/)
  exactKeys(value.history, ['conversationId', 'eventId', 'eventCount', 'latestSequence', 'memoryId', 'memoryRevision', 'memorySha256'], 'validation history')
  assert.match(value?.history?.conversationId ?? '', /^cnv_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value?.history?.eventId ?? '', /^evt_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value?.history?.memoryId ?? '', /^mem_[A-Za-z0-9_-]{8,128}$/)
  assert.equal(value?.history?.eventCount, 1)
  assert.equal(value?.history?.latestSequence, 1)
  assert.equal(value?.history?.memoryRevision, 1)
  assert.match(value?.history?.memorySha256 ?? '', /^[a-f0-9]{64}$/)
  exactKeys(value.pending, ['wakeId', 'attemptId', 'workId', 'approvalId', 'wakeState', 'attemptState', 'workState', 'approvalState', 'dispatchAllowed'], 'validation pending state')
  assert.match(value?.pending?.wakeId ?? '', /^wak_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value?.pending?.attemptId ?? '', /^atm_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value?.pending?.workId ?? '', /^wrk_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value?.pending?.approvalId ?? '', /^apr_[A-Za-z0-9_-]{8,128}$/)
  assert.equal(value?.pending?.wakeState, 'queued')
  assert.equal(value?.pending?.attemptState, 'awaiting_approval')
  assert.equal(value?.pending?.workState, 'pending')
  assert.equal(value?.pending?.approvalState, 'pending')
  assert.equal(value?.pending?.dispatchAllowed, stage === 'source-val12')
  exactKeys(value.priorExecution, ['workId', 'intentId', 'workState', 'intentState', 'launchAuditId', 'launchEventType'], 'validation prior execution')
  assert.match(value.priorExecution.workId, /^wrk_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.priorExecution.intentId, /^din_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.priorExecution.launchAuditId, /^aud_[A-Za-z0-9_-]{8,128}$/)
  assert.deepEqual({ work: value.priorExecution.workState, intent: value.priorExecution.intentState, event: value.priorExecution.launchEventType }, { work: 'succeeded', intent: 'accepted', event: 'executor.launch' })
  assert.equal(value?.recoveryMode, stage === 'source-val12' ? 'live' : 'restored_observation')
  assert.equal(value?.dispatchIntentCount, 1)
  assert.equal(value?.executorLaunchCount, 1)
  assert.equal(value?.redispatchCount, 0)
  assert.equal(value?.artifacts?.length, 2)
  const retained = value.artifacts.find(artifact => artifact.kind === 'retained')
  const absent = value.artifacts.find(artifact => artifact.kind === 'absent_after_backup')
  assert(retained && absent, 'validation receipt must expose retained and absent-after-backup artifacts')
  for (const artifact of [retained, absent]) {
    assert.match(artifact.artifactId ?? '', /^art_[A-Za-z0-9_-]{8,128}$/)
    assert.match(artifact.versionId ?? '', /^arv_[A-Za-z0-9_-]{8,128}$/)
    assert.match(artifact.sourceKmsKeyId ?? '', /^arn:aws:kms:us-east-1:167217327520:key\/[a-f0-9-]{36}$/)
    assert.match(artifact.currentKmsKeyId ?? '', /^arn:aws:kms:us-east-1:167217327520:key\/[a-f0-9-]{36}$/)
  }
  const sourceBucket = `stokd-agent-artifacts-source-val12-${accountId}`
  for (const artifact of [retained, absent]) {
    assert.equal(artifact.byteLength, 32)
    assert.equal(artifact.sha256, fixturePayloadSha256)
    assert.equal(artifact.sourceBucket, sourceBucket)
    assert.match(artifact.sourceS3VersionId, /^[A-Za-z0-9._=+\/-]{1,1024}$/)
    assert.match(artifact.currentS3VersionId, /^[A-Za-z0-9._=+\/-]{1,1024}$/)
  }
  assert.equal(retained.state, 'ready')
  assert.equal(retained.objectKey, `agents/validation/${fixtureOperationId}/retained.bin`)
  assert.equal(retained.currentBucket, artifactBucket)
  if (currentKmsKeyArn) assert.equal(retained.currentKmsKeyId, currentKmsKeyArn)
  assert.equal(retained.versionMapped, stage === 'restore-val12')
  assert.equal(absent.objectKey, `agents/validation/${fixtureOperationId}/absent-after-backup.bin`)
  assert.equal(absent.currentBucket, sourceBucket)
  assert.equal(absent.currentKmsKeyId, absent.sourceKmsKeyId)
  assert.equal(absent.versionMapped, false)
  assert.equal(absent.state, stage === 'source-val12' ? 'ready' : 'degraded_missing_object')
  assert.equal(absent.degradedReason, stage === 'restore-val12' ? 'missing_version' : undefined)
  assert.equal(absent.degradationProvenance, stage === 'restore-val12' ? 'work12_injected_missing_version_after_exact_source_head' : undefined)
  return { retained, absent }
  /* c8 ignore stop */
}

function fixturePointer(value) {
  return {
    operationId: value.operationId,
    payloadSha256: value.payloadSha256,
    payloadByteLength: value.payloadByteLength,
    semanticStateSha256: value.semanticStateSha256,
  }
}
function samePersistentCustody(actual, expected) {
  for (const key of ['artifactBucket', 'backupBucket', 'databaseVolumeId', 'kmsKeyArn']) if (actual[key] !== expected[key]) throw new Error(`redeploy changed retained ${key}`)
}
function physicalManifest(stage, manifest, planDigest, backupManifestVersionId, controlPlane) {
  const ids = resourceIds(manifest)
  const physicalResources = [
    { type: 'kms-key', id: ids.kmsKeyArn },
    { type: 's3-bucket', id: ids.artifactBucket },
    { type: 's3-bucket', id: ids.backupBucket },
    { type: 'ebs-volume', id: ids.databaseVolumeId },
    { type: 'mongo-instance', id: ids.mongoInstanceId },
    { type: 'mongo-network-interface', id: manifest.mongo.networkInterfaceId },
    { type: 'ecs-cluster', id: manifest.cluster.arn },
    { type: 'vpc', id: manifest.vpc.id },
    ...controlPlane.privateRouteTableIds.map(id => ({ type: 'private-route-table', id })),
    ...controlPlane.publicRouteTableIds.map(id => ({ type: 'public-route-table', id })),
    ...controlPlane.endpointIds.map(id => ({ type: 'vpc-endpoint', id })),
    ...Object.values(controlPlane.securityGroupIds).map(id => ({ type: 'security-group', id })),
    ...controlPlane.roles.map(value => ({ type: 'iam-role', id: value.roleName })),
  ]
  return {
    schemaVersion: '1.0', accountId, region, stage, sourceDigest: manifest.sourceDigest, planDigest,
    physicalResources,
    custodyManifest: { artifactBucket: ids.artifactBucket, backupBucket: ids.backupBucket, databaseVolumeId: ids.databaseVolumeId, ...(backupManifestVersionId ? { backupManifestVersionId } : {}) },
  }
}
function proveDestructiveRefusal(stage, manifest) {
  const directory = mkdtempSync(join(tmpdir(), 'stokd-agent-destroy-refusal-'))
  const path = join(directory, 'physical-resources.json')
  writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 })
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/infra-action.mjs'), 'data', 'remove', '--stage', stage, '--destructive-ack', 'invalid-reviewed-acknowledgement'], {
    cwd: root,
    env: { ...process.env, AGENT_PHYSICAL_RESOURCE_MANIFEST: path, AGENT_DESTRUCTIVE_ACK: 'invalid-reviewed-acknowledgement' },
    encoding: 'utf8',
  })
  if (result.status === 0 || !/remove refused|resource-bound acknowledgement/.test(`${result.stderr}\n${result.stdout}`)) throw new Error('real destructive-plan refusal did not fail closed')
}

async function runScenario(mode, stage, component, requestId, validationRunId, sourceDigest) {
  const manifest = readDataManifest(stage)
  if (manifest.sourceDigest !== sourceDigest) throw new Error('scenario manifest belongs to a different source digest')
  const requestDigest = createHash('sha256').update(`${requestId}\0${stage}\0${component}\0${mode}`).digest('hex')
  const planDigest = process.env.AGENT_PLAN_DIGEST
  if (!/^[a-f0-9]{64}$/.test(planDigest ?? '')) throw new Error('reviewed plan digest is required')
  if (mode === 'migrate' || mode === 'migrate-and-redeploy-proof') {
    if (component !== 'data') throw new Error('migration scenario is data-component only')
    const operationId = `migrate-${requestDigest.slice(0, 32)}`
    const migrated = await sendCommand(documentNames.migrate, manifest.mongo.instanceId, { OperationId: operationId, TargetStage: stage })
    const receipt = lastEnvelope(migrated.output, 'migrate')
    if (receipt.environment !== stage || receipt.databaseName !== `agent_${stage.replaceAll('-', '_')}` || receipt.replicaSet !== 'agent-rs' || receipt.serverVersion !== '7.0.29' || receipt.featureCompatibilityVersion !== '7.0' || receipt.schemaVersion !== 1 || receipt.migrationStatus !== 'ready') throw new Error('migration receipt does not prove the frozen catalog')
    if (mode === 'migrate') return { schemaVersion: '1.0', mode, stage, commandId: migrated.commandId, receipt }
  }

  if (mode === 'source-proof') {
    if (stage !== 'source-val12' || component !== 'api') throw new Error('source proof requires source-val12 API')
    const api = currentApi(manifest)
    const health = await httpJson('https://agent-source-val12.stokd.cloud/health')
    if (health?.ok !== true || health?.recoveryMode !== 'active' || health?.storage?.serverVersion !== '7.0.29') throw new Error('source API storage readiness is invalid')
    const seeded = await sendCommand(documentNames.seed, manifest.mongo.instanceId)
    const seed = lastEnvelope(seeded.output, 'validation-seed')
    assertFixtureReceipt(seed, stage, manifest.custody.artifactBucket, undefined, manifest.custody.kmsKeyArn)
    const fixture = await httpJson('https://agent-source-val12.stokd.cloud/v1/validation-fixture')
    if (fixture?.ok !== true || fixture?.recoveryMode !== 'active') throw new Error('source API did not read the fixed durable fixture')
    assertFixtureReceipt(fixture.fixture, stage, manifest.custody.artifactBucket, seed.semanticStateSha256, manifest.custody.kmsKeyArn)
    const backedUp = await sendCommand(documentNames.backup, manifest.mongo.instanceId)
    const backup = lastEnvelope(backedUp.output, 'backup')
    if (backup.manifestSha256 !== backup.manifestCustody?.sha256 || backup.archiveCustody?.bucket !== manifest.custody.backupBucket || backup.manifestCustody?.bucket !== manifest.custody.backupBucket) throw new Error('backup receipt custody is invalid')
    exactKeys(backup.sourceResourceIds, ['artifactBucket', 'backupBucket', 'databaseVolumeId', 'kmsKeyArn', 'mongoInstanceId'], 'backup source resource IDs')
    exactKeys(backup.sourceSecretVersionIds, ['runtime', 'migration', 'backup'], 'backup source secret VersionIds')
    const controlPlane = await inspectAgentControlPlane({ aws, manifest })
    const evidence = {
      schemaVersion: '1.0', stage, requestId, sourceDigest: manifest.sourceDigest, planDigest, recordedAt: new Date().toISOString(),
      resourceIds: resourceIds(manifest), api, fixture: fixturePointer(fixture.fixture),
      backup: { backupId: backup.backupId, restorePoint: backup.restorePoint, archiveCustody: backup.archiveCustody, manifestCustody: backup.manifestCustody, manifestSha256: backup.manifestSha256, sourceSecretVersionIds: backup.sourceSecretVersionIds },
      controlPlane, destructivePlanRefused: true,
    }
    const physical = physicalManifest(stage, manifest, planDigest, backup.manifestCustody.versionId, controlPlane)
    proveDestructiveRefusal(stage, physical)
    const fixtureEvidence = writeEvidence(stage, 'fixture', manifest, fixture.fixture)
    const physicalEvidence = writeEvidence(stage, 'physical-resources', manifest, physical)
    const accumulatedEvidence = writeEvidence(stage, 'evidence', manifest, evidence)
    return { schemaVersion: '1.0', mode, stage, seedCommandId: seeded.commandId, backupCommandId: backedUp.commandId, evidenceParameter: evidenceParameterName(stage, 'evidence'), physicalParameter: evidenceParameterName(stage, 'physical-resources'), evidenceVersionIds: { evidence: accumulatedEvidence.versionId, fixture: fixtureEvidence.versionId, physicalResources: physicalEvidence.versionId } }
  }

  if (mode === 'restore-proof') {
    if (stage !== 'restore-val12' || component !== 'api') throw new Error('restore proof requires restore-val12 API')
    const sourceManifest = readDataManifest('source-val12')
    const source = readEvidence('source-val12', 'evidence', sourceManifest).value
    const sourceFixture = readEvidence('source-val12', 'fixture', sourceManifest).value
    assertFixtureReceipt(sourceFixture, 'source-val12', source.resourceIds.artifactBucket, source.fixture.semanticStateSha256, sourceManifest.custody.kmsKeyArn)
    const priorRestorePointer = readParameter(evidenceParameterName(stage, 'evidence'), false)
    const priorRestoreEvidence = priorRestorePointer ? readEvidence(stage, 'evidence', manifest) : undefined
    const priorRestore = priorRestoreEvidence?.value
    const selected = source.backup
    const operationId = `work12-${createHash('sha256').update(`${selected.manifestCustody.versionId}\0${selected.archiveCustody.versionId}`).digest('hex').slice(0, 32)}`
    const restoreLockBinding = buildRestoreLockBinding({
      validationRunId, sourceDigest, planDigest, operationId,
      sourceResourceIds: resourceIds(sourceManifest), targetResourceIds: resourceIds(manifest),
      selectedBackup: {
        backupId: selected.backupId, manifestVersionId: selected.manifestCustody.versionId,
        manifestSha256: selected.manifestSha256, archiveVersionId: selected.archiveCustody.versionId,
        archiveSha256: selected.archiveCustody.sha256,
      },
    })
    const restoreLock = createOrResumeRestoreLock({ aws, binding: restoreLockBinding })
    if (!restoreLock.resumed) {
      currentApi(manifest)
      if (!priorRestore) {
        const absent = await httpJson('https://agent-restore-val12.stokd.cloud/v1/validation-fixture', 404)
        if (absent?.error !== 'fixed_validation_fixture_not_found') throw new Error('blank restore target unexpectedly exposed the source fixture')
      }
    }
    const restored = await sendCommand(documentNames.restore, manifest.mongo.instanceId, {
      OperationId: operationId,
      ManifestKey: selected.manifestCustody.objectKey,
      ManifestVersionId: selected.manifestCustody.versionId,
      ManifestSha256: selected.manifestSha256,
      ArchiveKey: selected.archiveCustody.objectKey,
      ArchiveVersionId: selected.archiveCustody.versionId,
      ArchiveSha256: selected.archiveCustody.sha256,
    })
    const report = lastEnvelope(restored.output, 'restore-finalize')
    const denials = report.credentialRotation?.archivedCredentialProbeResults
    if (report.recoveryMode !== 'restored_observation' || report.redispatchCount !== 0 || report.dispatchIntentCountBefore !== report.dispatchIntentCountAfter || !Array.isArray(denials) || denials.length !== 6 || denials.some(value => value.rejected !== true) || report.credentialRotation?.steadyStatePrincipalsOnly !== true) throw new Error('restore report omitted zero-redispatch or retired-credential evidence')
    const sourceAbsent = sourceFixture.artifacts.find(value => value.kind === 'absent_after_backup')
    assert(sourceAbsent)
    assert.deepEqual(report.degraded, [{
      objectKey: sourceAbsent.objectKey, versionId: sourceAbsent.sourceS3VersionId, reason: 'missing_version',
      provenance: 'work12_injected_missing_version_after_exact_source_head',
    }])
    assert.equal(report.readyObjectVersions, 3)
    assert.equal(report.degradedObjectVersions, 1)
    assert.deepEqual(report.dispatchBoundaryAfter, report.dispatchBoundaryBefore)
    assert.deepEqual(report.dispatchBoundaryAfter, { accepted: 1, launched: 1 })
    currentApi(manifest)
    const health = await httpJson('https://agent-restore-val12.stokd.cloud/health')
    if (health?.ok !== true || health?.recoveryMode !== 'restored_observation') throw new Error('restore API is not observation-only ready')
    const fixture = await httpJson('https://agent-restore-val12.stokd.cloud/v1/validation-fixture')
    if (fixture?.ok !== true || fixture?.recoveryMode !== 'restored_observation') throw new Error('restored API did not read the exact source fixture')
    assertFixtureReceipt(fixture.fixture, stage, manifest.custody.artifactBucket, sourceFixture.semanticStateSha256, manifest.custody.kmsKeyArn)
    const controlPlane = await inspectAgentControlPlane({ aws, manifest })
    const evidence = {
      schemaVersion: '1.0', stage, requestId, sourceDigest: manifest.sourceDigest, planDigest, recordedAt: new Date().toISOString(),
      resourceIds: resourceIds(manifest), fixture: fixturePointer(fixture.fixture),
      restore: { operationId, recoveryMode: report.recoveryMode, redispatchCount: report.redispatchCount, dispatchIntentCountBefore: report.dispatchIntentCountBefore, dispatchIntentCountAfter: report.dispatchIntentCountAfter, dispatchBoundaryBefore: report.dispatchBoundaryBefore, dispatchBoundaryAfter: report.dispatchBoundaryAfter, readyObjectVersions: report.readyObjectVersions, degradedObjectVersions: report.degradedObjectVersions, degraded: report.degraded, targetSecretVersionIds: Object.fromEntries(report.credentialRotation.principals.map(value => [value.kind, value.secretVersionId])), archivedCredentialProbeResults: denials },
      sourceBackup: { backupId: selected.backupId, manifestVersionId: selected.manifestCustody.versionId, archiveVersionId: selected.archiveCustody.versionId },
      controlPlane, destructivePlanRefused: true,
    }
    const reusePriorEvidence = restoreLock.resumed && priorRestore?.requestId === requestId && priorRestore?.sourceDigest === sourceDigest && priorRestore?.planDigest === planDigest
    if (reusePriorEvidence) {
      samePersistentCustody(resourceIds(manifest), priorRestore.resourceIds)
      assert.deepEqual(fixturePointer(fixture.fixture), priorRestore.fixture)
      const existingFixture = readEvidence(stage, 'fixture', manifest)
      const existingPhysical = readEvidence(stage, 'physical-resources', manifest)
      assert.deepEqual(existingFixture.value, fixture.fixture, 'restore retry changed the frozen fixture evidence')
      return {
        schemaVersion: '1.0', mode, stage, restoreCommandId: restored.commandId, restoreAdmissionLock: restoreLockBinding,
        evidenceParameter: evidenceParameterName(stage, 'evidence'), physicalParameter: evidenceParameterName(stage, 'physical-resources'),
        evidenceVersionIds: { evidence: priorRestoreEvidence.pointer.versionId, fixture: existingFixture.pointer.versionId, physicalResources: existingPhysical.pointer.versionId },
      }
    }
    const physical = physicalManifest(stage, manifest, planDigest, selected.manifestCustody.versionId, controlPlane)
    proveDestructiveRefusal(stage, physical)
    const fixtureEvidence = writeEvidence(stage, 'fixture', manifest, fixture.fixture)
    const physicalEvidence = writeEvidence(stage, 'physical-resources', manifest, physical)
    const accumulatedEvidence = writeEvidence(stage, 'evidence', manifest, evidence)
    return { schemaVersion: '1.0', mode, stage, restoreCommandId: restored.commandId, restoreAdmissionLock: restoreLockBinding, evidenceParameter: evidenceParameterName(stage, 'evidence'), physicalParameter: evidenceParameterName(stage, 'physical-resources'), evidenceVersionIds: { evidence: accumulatedEvidence.versionId, fixture: fixtureEvidence.versionId, physicalResources: physicalEvidence.versionId } }
  }

  if (mode === 'redeploy-proof' || mode === 'migrate-and-redeploy-proof') {
    const prior = readEvidence(stage, 'evidence', manifest).value
    const priorFixture = readEvidence(stage, 'fixture', manifest).value
    samePersistentCustody(resourceIds(manifest), prior.resourceIds)
    currentApi(manifest)
    const health = await httpJson(`https://agent-${stage}.stokd.cloud/health`)
    const expectedMode = stage === 'source-val12' ? 'active' : 'restored_observation'
    if (health?.ok !== true || health?.recoveryMode !== expectedMode) throw new Error('redeployed API is not storage-ready')
    const fixture = await httpJson(`https://agent-${stage}.stokd.cloud/v1/validation-fixture`)
    if (fixture?.ok !== true) throw new Error('redeploy did not preserve the durable fixture')
    assertFixtureReceipt(fixture.fixture, stage, manifest.custody.artifactBucket, priorFixture.semanticStateSha256, manifest.custody.kmsKeyArn)
    const controlPlane = await inspectAgentControlPlane({ aws, manifest })
    const refreshed = {
      ...prior,
      requestId,
      sourceDigest: manifest.sourceDigest,
      planDigest,
      redeployedAt: new Date().toISOString(),
      priorMongoInstanceId: prior.resourceIds.mongoInstanceId,
      resourceIds: resourceIds(manifest),
      fixture: fixturePointer(fixture.fixture),
      controlPlane, destructivePlanRefused: true,
      redeployProofs: {
        ...(prior.redeployProofs ?? {}),
        [component]: {
          sourceDigest: manifest.sourceDigest,
          planDigest,
          verifiedAt: new Date().toISOString(),
          taskDefinitionArn: currentApi(manifest).taskDefinitionArn,
          mongoInstanceId: manifest.mongo.instanceId,
          retainedCustodyUnchanged: true,
          fixturePreserved: true,
        },
      },
    }
    const physical = physicalManifest(stage, manifest, planDigest, prior.backup?.manifestCustody?.versionId ?? prior.sourceBackup?.manifestVersionId, controlPlane)
    proveDestructiveRefusal(stage, physical)
    const fixtureEvidence = writeEvidence(stage, 'fixture', manifest, fixture.fixture)
    const physicalEvidence = writeEvidence(stage, 'physical-resources', manifest, physical)
    const accumulatedEvidence = writeEvidence(stage, 'evidence', manifest, refreshed)
    return { schemaVersion: '1.0', mode, stage, retainedCustodyUnchanged: true, fixturePreserved: true, evidenceParameter: evidenceParameterName(stage, 'evidence'), evidenceVersionIds: { evidence: accumulatedEvidence.versionId, fixture: fixtureEvidence.versionId, physicalResources: physicalEvidence.versionId } }
  }
  throw new Error('validation scenario mode is unsupported')
}

function parseArguments(argv) {
  const [mode, ...rest] = argv
  if (!['migrate', 'source-proof', 'restore-proof', 'redeploy-proof', 'migrate-and-redeploy-proof'].includes(mode)) throw new Error('validation scenario mode is invalid')
  const allowed = new Set(['--stage', '--component', '--request-id', '--phase', '--validation-run-id'])
  if (rest.length !== 10) throw new Error('validation scenario requires exact stage, component, request ID, phase, and validation run ID')
  const values = {}
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    if (!allowed.has(flag) || values[flag] !== undefined || !rest[index + 1]) throw new Error('validation scenario arguments are invalid')
    values[flag] = rest[index + 1]
  }
  if (!['source-val12', 'restore-val12'].includes(values['--stage']) || !['data', 'api'].includes(values['--component']) || !/^[a-z0-9][a-z0-9.-]{2,80}$/.test(values['--request-id']) || !/^github-[1-9][0-9]{0,19}$/.test(values['--validation-run-id'])) throw new Error('validation scenario identity is invalid')
  const phase = work12Phases.find(value => value.phase === values['--phase'])
  if (!phase || phase.stage !== values['--stage'] || phase.component !== values['--component'] || phase.scenario !== mode || values['--request-id'] !== `${values['--validation-run-id']}-${phase.phase}`) throw new Error('validation scenario does not match the exact ordered phase')
  return { mode, stage: values['--stage'], component: values['--component'], requestId: values['--request-id'], phase: phase.phase, validationRunId: values['--validation-run-id'] }
}

try {
  const input = parseArguments(process.argv.slice(2))
  const sourceDigest = process.env.GITHUB_SHA
  if (!/^[a-f0-9]{40}$/.test(sourceDigest ?? '')) throw new Error('GITHUB_SHA must be the exact validation source digest')
  const identity = parseCallerIdentity(aws(['sts', 'get-caller-identity', '--output', 'json']))
  assertBoundedDeploymentIdentity(identity, process.env)
  const result = await runScenario(input.mode, input.stage, input.component, input.requestId, input.validationRunId, sourceDigest)
  const completion = recordPhaseCompletion({ aws, phase: input.phase, validationRunId: input.validationRunId, sourceDigest, planDigest: process.env.AGENT_PLAN_DIGEST, result })
  if (result.restoreAdmissionLock) releaseRestoreLock({ aws, expected: result.restoreAdmissionLock })
  process.stdout.write(`${JSON.stringify({ ...result, phaseReceipt: completion.pointer })}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}

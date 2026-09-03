import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const accountId = '167217327520'
export const fixtureOperationId = 'valop_work12_durable_fixture'
const fixturePayload = createHash('sha256').update('stokd-agent/cloud-agents-mvp/fixed-validation-fixture/v1').digest()
export const fixturePayloadSha256 = createHash('sha256').update(fixturePayload).digest('hex')
export const injectedMissingVersionProvenance = 'work12_injected_missing_version_after_exact_source_head'

function exactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields changed`)
}

export function assertValidationFixtureReceipt({ value, stage, artifactBucket, currentKmsKeyArn, expectedSemanticStateSha256 }) {
  assert(['source-val12', 'restore-val12'].includes(stage), 'validation fixture stage is invalid')
  exactKeys(value, ['schemaVersion', 'operationId', 'payloadSha256', 'payloadByteLength', 'persistedAt', 'semanticStateSha256', 'identity', 'history', 'pending', 'priorExecution', 'artifacts', 'recoveryMode', 'dispatchIntentCount', 'executorLaunchCount', 'redispatchCount'], 'validation fixture receipt')
  assert.equal(value.schemaVersion, '1.0')
  assert.equal(value.operationId, fixtureOperationId)
  assert.equal(value.payloadSha256, fixturePayloadSha256)
  assert.equal(value.payloadByteLength, 32)
  assert.match(value.semanticStateSha256, /^[a-f0-9]{64}$/)
  assert.equal(new Date(value.persistedAt).toISOString(), value.persistedAt)
  if (expectedSemanticStateSha256 !== undefined) assert.equal(value.semanticStateSha256, expectedSemanticStateSha256)

  exactKeys(value.identity, ['ownerSubject', 'agentId', 'normalizedName', 'profileRevision', 'profileSha256'], 'validation identity')
  assert.match(value.identity.ownerSubject, /^own_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.identity.agentId, /^agt_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.identity.normalizedName, /^validation-[a-f0-9]{24}$/)
  assert.equal(value.identity.profileRevision, 1)
  assert.match(value.identity.profileSha256, /^[a-f0-9]{64}$/)

  exactKeys(value.history, ['conversationId', 'eventId', 'eventCount', 'latestSequence', 'memoryId', 'memoryRevision', 'memorySha256'], 'validation history')
  assert.match(value.history.conversationId, /^cnv_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.history.eventId, /^evt_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.history.memoryId, /^mem_[A-Za-z0-9_-]{8,128}$/)
  assert.deepEqual({ eventCount: value.history.eventCount, latestSequence: value.history.latestSequence, memoryRevision: value.history.memoryRevision }, { eventCount: 1, latestSequence: 1, memoryRevision: 1 })
  assert.match(value.history.memorySha256, /^[a-f0-9]{64}$/)

  exactKeys(value.pending, ['wakeId', 'attemptId', 'workId', 'approvalId', 'wakeState', 'attemptState', 'workState', 'approvalState', 'dispatchAllowed'], 'validation pending state')
  for (const [name, prefix] of [['wakeId', 'wak'], ['attemptId', 'atm'], ['workId', 'wrk'], ['approvalId', 'apr']]) assert.match(value.pending[name], new RegExp(`^${prefix}_[A-Za-z0-9_-]{8,128}$`))
  assert.deepEqual({ wake: value.pending.wakeState, attempt: value.pending.attemptState, work: value.pending.workState, approval: value.pending.approvalState }, { wake: 'queued', attempt: 'awaiting_approval', work: 'pending', approval: 'pending' })
  assert.equal(value.pending.dispatchAllowed, stage === 'source-val12')

  exactKeys(value.priorExecution, ['workId', 'intentId', 'workState', 'intentState', 'launchAuditId', 'launchEventType'], 'validation prior execution')
  assert.match(value.priorExecution.workId, /^wrk_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.priorExecution.intentId, /^din_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.priorExecution.launchAuditId, /^aud_[A-Za-z0-9_-]{8,128}$/)
  assert.deepEqual({ work: value.priorExecution.workState, intent: value.priorExecution.intentState, event: value.priorExecution.launchEventType }, { work: 'succeeded', intent: 'accepted', event: 'executor.launch' })
  assert.equal(value.recoveryMode, stage === 'source-val12' ? 'live' : 'restored_observation')
  assert.deepEqual({ intents: value.dispatchIntentCount, launches: value.executorLaunchCount, redispatches: value.redispatchCount }, { intents: 1, launches: 1, redispatches: 0 })

  assert.equal(value.artifacts.length, 2)
  assert.deepEqual(value.artifacts.map(artifact => artifact.kind), ['retained', 'absent_after_backup'])
  const [retained, absent] = value.artifacts
  const commonArtifactKeys = ['kind', 'artifactId', 'versionId', 'state', 'objectKey', 'sha256', 'byteLength', 'sourceBucket', 'sourceKmsKeyId', 'sourceS3VersionId', 'currentBucket', 'currentKmsKeyId', 'currentS3VersionId', 'versionMapped']
  exactKeys(retained, commonArtifactKeys, 'retained validation artifact')
  exactKeys(absent, stage === 'source-val12' ? commonArtifactKeys : [...commonArtifactKeys, 'degradedReason', 'degradationProvenance'], 'absent-after-backup validation artifact')
  const sourceBucket = `stokd-agent-artifacts-source-val12-${accountId}`
  for (const artifact of [retained, absent]) {
    assert.match(artifact.artifactId, /^art_[A-Za-z0-9_-]{8,128}$/)
    assert.match(artifact.versionId, /^arv_[A-Za-z0-9_-]{8,128}$/)
    assert.equal(artifact.sha256, fixturePayloadSha256)
    assert.equal(artifact.byteLength, 32)
    assert.equal(artifact.sourceBucket, sourceBucket)
    assert.match(artifact.sourceKmsKeyId, /^arn:aws:kms:us-east-1:167217327520:key\/[a-f0-9-]{36}$/)
    assert.match(artifact.currentKmsKeyId, /^arn:aws:kms:us-east-1:167217327520:key\/[a-f0-9-]{36}$/)
    assert.match(artifact.sourceS3VersionId, /^[A-Za-z0-9._=+\/-]{1,1024}$/)
    assert.match(artifact.currentS3VersionId, /^[A-Za-z0-9._=+\/-]{1,1024}$/)
  }
  assert.equal(retained.state, 'ready')
  assert.equal(retained.objectKey, `agents/validation/${fixtureOperationId}/retained.bin`)
  assert.equal(retained.currentBucket, artifactBucket)
  assert.equal(retained.currentKmsKeyId, currentKmsKeyArn)
  assert.equal(retained.versionMapped, stage === 'restore-val12')
  assert.equal(absent.objectKey, `agents/validation/${fixtureOperationId}/absent-after-backup.bin`)
  assert.equal(absent.currentBucket, sourceBucket)
  assert.equal(absent.currentKmsKeyId, absent.sourceKmsKeyId)
  assert.equal(absent.currentS3VersionId, absent.sourceS3VersionId)
  assert.equal(absent.versionMapped, false)
  assert.equal(absent.state, stage === 'source-val12' ? 'ready' : 'degraded_missing_object')
  assert.equal(absent.degradedReason, stage === 'restore-val12' ? 'missing_version' : undefined)
  assert.equal(absent.degradationProvenance, stage === 'restore-val12' ? injectedMissingVersionProvenance : undefined)
  return { retained, absent }
}

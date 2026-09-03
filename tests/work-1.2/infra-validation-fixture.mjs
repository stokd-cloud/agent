import assert from 'node:assert/strict'
import test from 'node:test'
import { assertValidationFixtureReceipt, fixturePayloadSha256 } from '../../scripts/infra-validation-fixture.mjs'

const sourceBucket = 'stokd-agent-artifacts-source-val12-167217327520'
const restoreBucket = 'stokd-agent-artifacts-restore-val12-167217327520'
const sourceKms = 'arn:aws:kms:us-east-1:167217327520:key/11111111-2222-3333-4444-555555555555'
const restoreKms = 'arn:aws:kms:us-east-1:167217327520:key/66666666-7777-8888-9999-aaaaaaaaaaaa'
const semanticStateSha256 = 'a'.repeat(64)

function receipt(stage) {
  const restored = stage === 'restore-val12'
  const common = {
    sha256: fixturePayloadSha256, byteLength: 32, sourceBucket, sourceKmsKeyId: sourceKms,
  }
  return {
    schemaVersion: '1.0', operationId: 'valop_work12_durable_fixture', payloadSha256: fixturePayloadSha256,
    payloadByteLength: 32, persistedAt: '2026-09-02T00:00:00.000Z', semanticStateSha256,
    identity: { ownerSubject: 'own_12345678', agentId: 'agt_12345678', normalizedName: 'validation-1234567890abcdef12345678', profileRevision: 1, profileSha256: 'b'.repeat(64) },
    history: { conversationId: 'cnv_12345678', eventId: 'evt_12345678', eventCount: 1, latestSequence: 1, memoryId: 'mem_12345678', memoryRevision: 1, memorySha256: 'c'.repeat(64) },
    pending: { wakeId: 'wak_12345678', attemptId: 'atm_12345678', workId: 'wrk_12345678', approvalId: 'apr_12345678', wakeState: 'queued', attemptState: 'awaiting_approval', workState: 'pending', approvalState: 'pending', dispatchAllowed: !restored },
    priorExecution: { workId: 'wrk_12345678p', intentId: 'din_12345678', workState: 'succeeded', intentState: 'accepted', launchAuditId: 'aud_12345678l', launchEventType: 'executor.launch' },
    artifacts: [
      { ...common, kind: 'retained', artifactId: 'art_123456781', versionId: 'arv_123456781', state: 'ready', objectKey: 'agents/validation/valop_work12_durable_fixture/retained.bin', sourceS3VersionId: 'source-retained-version', currentBucket: restored ? restoreBucket : sourceBucket, currentKmsKeyId: restored ? restoreKms : sourceKms, currentS3VersionId: restored ? 'restore-retained-version' : 'source-retained-version', versionMapped: restored },
      { ...common, kind: 'absent_after_backup', artifactId: 'art_123456782', versionId: 'arv_123456782', state: restored ? 'degraded_missing_object' : 'ready', objectKey: 'agents/validation/valop_work12_durable_fixture/absent-after-backup.bin', sourceS3VersionId: 'source-absent-version', currentBucket: sourceBucket, currentKmsKeyId: sourceKms, currentS3VersionId: 'source-absent-version', versionMapped: false, ...(restored ? { degradedReason: 'missing_version', degradationProvenance: 'work12_injected_missing_version_after_exact_source_head' } : {}) },
    ],
    recoveryMode: restored ? 'restored_observation' : 'live', dispatchIntentCount: 1, executorLaunchCount: 1, redispatchCount: 0,
  }
}

test('scenario and final validator shared fixture schema accepts the frozen source/restore contract', () => {
  const source = receipt('source-val12')
  const restore = receipt('restore-val12')
  assertValidationFixtureReceipt({ value: source, stage: 'source-val12', artifactBucket: sourceBucket, currentKmsKeyArn: sourceKms })
  assertValidationFixtureReceipt({ value: restore, stage: 'restore-val12', artifactBucket: restoreBucket, currentKmsKeyArn: restoreKms, expectedSemanticStateSha256: source.semanticStateSha256 })
})

test('fixture schema rejects count drift, artifact shape confusion, and missing injected provenance', () => {
  assert.throws(() => assertValidationFixtureReceipt({ value: { ...receipt('source-val12'), dispatchIntentCount: 0 }, stage: 'source-val12', artifactBucket: sourceBucket, currentKmsKeyArn: sourceKms }), /Expected values/)
  const extra = receipt('restore-val12')
  extra.artifacts[0] = { ...extra.artifacts[0], unreviewed: true }
  assert.throws(() => assertValidationFixtureReceipt({ value: extra, stage: 'restore-val12', artifactBucket: restoreBucket, currentKmsKeyArn: restoreKms }), /fields changed/)
  const noProvenance = receipt('restore-val12')
  delete noProvenance.artifacts[1].degradationProvenance
  assert.throws(() => assertValidationFixtureReceipt({ value: noProvenance, stage: 'restore-val12', artifactBucket: restoreBucket, currentKmsKeyArn: restoreKms }), /fields changed|degradationProvenance/)
})

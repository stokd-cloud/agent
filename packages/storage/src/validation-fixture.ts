import { createHash } from 'node:crypto'
import type { ClientSession, Db, Document } from 'mongodb'
import { AgentStorageError } from './errors.js'
import type { ObjectCustodyRecord } from './object-custody.js'
import { readServerTime } from './readiness.js'
import { withAgentTransaction } from './transactions.js'

export interface ValidationFixtureArtifactCustody {
  readonly retained: ObjectCustodyRecord
  readonly absentAfterBackup: ObjectCustodyRecord
}

export interface ValidationFixtureArtifactReport {
  readonly kind: 'retained' | 'absent_after_backup'
  readonly artifactId: string
  readonly versionId: string
  readonly state: 'ready' | 'degraded_missing_object'
  readonly objectKey: string
  readonly sha256: string
  readonly byteLength: 32
  readonly sourceBucket: string
  readonly sourceKmsKeyId: string
  readonly sourceS3VersionId: string
  readonly currentBucket: string
  readonly currentKmsKeyId: string
  readonly currentS3VersionId: string
  readonly versionMapped: boolean
  readonly degradedReason?: 'missing_version'
  readonly degradationProvenance?: 'work12_injected_missing_version_after_exact_source_head'
}

export interface ValidationFixtureReceipt {
  readonly schemaVersion: '1.0'
  readonly operationId: string
  readonly payloadSha256: string
  readonly payloadByteLength: 32
  readonly persistedAt: string
  readonly semanticStateSha256: string
  readonly identity: { readonly ownerSubject: string; readonly agentId: string; readonly normalizedName: string; readonly profileRevision: 1; readonly profileSha256: string }
  readonly history: { readonly conversationId: string; readonly eventId: string; readonly eventCount: 1; readonly latestSequence: 1; readonly memoryId: string; readonly memoryRevision: 1; readonly memorySha256: string }
  readonly pending: { readonly wakeId: string; readonly attemptId: string; readonly workId: string; readonly approvalId: string; readonly wakeState: 'queued'; readonly attemptState: 'awaiting_approval'; readonly workState: 'pending'; readonly approvalState: 'pending'; readonly dispatchAllowed: boolean }
  readonly priorExecution: { readonly workId: string; readonly intentId: string; readonly workState: 'succeeded'; readonly intentState: 'accepted'; readonly launchAuditId: string; readonly launchEventType: 'executor.launch' }
  readonly artifacts: readonly [ValidationFixtureArtifactReport, ValidationFixtureArtifactReport]
  readonly recoveryMode: 'live' | 'restored_observation'
  readonly dispatchIntentCount: 1
  readonly executorLaunchCount: 1
  readonly redispatchCount: 0
}

interface FixtureIds {
  readonly ownerSubject: string; readonly agentId: string; readonly conversationId: string; readonly eventId: string; readonly memoryId: string
  readonly wakeId: string; readonly attemptId: string; readonly workId: string; readonly approvalId: string
  readonly priorWorkId: string; readonly priorIntentId: string; readonly priorLaunchAuditId: string
  readonly retainedArtifactId: string; readonly retainedVersionId: string; readonly absentArtifactId: string; readonly absentVersionId: string
  readonly auditId: string; readonly normalizedName: string
}

function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function assertOperationId(value: string): void {
  if (!/^valop_[A-Za-z0-9_-]{8,64}$/.test(value)) throw new AgentStorageError('invalid_storage_config', 'validation operationId is invalid')
}
function ids(operationId: string): FixtureIds {
  const digest = sha256(operationId).slice(0, 24)
  return {
    ownerSubject: `own_${digest}`, agentId: `agt_${digest}`, conversationId: `cnv_${digest}`, eventId: `evt_${digest}`,
    memoryId: `mem_${digest}`, wakeId: `wak_${digest}`, attemptId: `atm_${digest}`, workId: `wrk_${digest}`, approvalId: `apr_${digest}`,
    priorWorkId: `wrk_${digest}p`, priorIntentId: `din_${digest}`, priorLaunchAuditId: `aud_${digest}l`,
    retainedArtifactId: `art_${digest}1`, retainedVersionId: `arv_${digest}1`, absentArtifactId: `art_${digest}2`, absentVersionId: `arv_${digest}2`,
    auditId: `aud_${digest}`, normalizedName: `validation-${digest}`,
  }
}

export function validationFixtureRetainedObjectKey(operationId: string): string {
  assertOperationId(operationId)
  return `agents/validation/${operationId}/retained.bin`
}

export function validationFixtureAbsentAfterBackupObjectKey(operationId: string): string {
  assertOperationId(operationId)
  return `agents/validation/${operationId}/absent-after-backup.bin`
}

function assertCustody(record: ObjectCustodyRecord, name: string, objectKey: string, payloadSha256: string, sourceResourceIds: Readonly<Record<string, string>>): void {
  const keys = Object.keys(record as unknown as Record<string, unknown>).sort()
  const expected = ['bucket', 'byteLength', 'capturedAt', 'eTag', 'kmsKeyId', 'objectKey', 'sha256', 'versionId'].sort()
  const capturedAt = new Date(record.capturedAt)
  if (
    JSON.stringify(keys) !== JSON.stringify(expected) || record.bucket !== sourceResourceIds.artifactBucket ||
    record.kmsKeyId !== sourceResourceIds.kmsKeyArn || record.objectKey !== objectKey || record.sha256 !== payloadSha256 ||
    record.byteLength !== 32 || !record.versionId || !record.eTag || Number.isNaN(capturedAt.getTime())
  ) throw new AgentStorageError('object_custody_mismatch', `validation ${name} artifact does not match the fixed payload and source custody`)
}

function stableSemantic(operationId: string, payloadSha256: string, artifacts: ValidationFixtureArtifactCustody): Readonly<Record<string, any>> {
  const value = ids(operationId)
  return {
    identity: { ownerSubject: value.ownerSubject, agentId: value.agentId, normalizedName: value.normalizedName, profileRevision: 1, profileSha256: sha256(`profile\0${payloadSha256}`) },
    history: { conversationId: value.conversationId, eventId: value.eventId, eventCount: 1, latestSequence: 1, memoryId: value.memoryId, memoryRevision: 1, memorySha256: sha256(`memory\0${payloadSha256}`) },
    pending: { wakeId: value.wakeId, attemptId: value.attemptId, workId: value.workId, approvalId: value.approvalId, wakeState: 'queued', attemptState: 'awaiting_approval', workState: 'pending', approvalState: 'pending' },
    priorExecution: { workId: value.priorWorkId, intentId: value.priorIntentId, workState: 'succeeded', intentState: 'accepted', launchAuditId: value.priorLaunchAuditId, launchEventType: 'executor.launch' },
    artifacts: {
      retained: { artifactId: value.retainedArtifactId, versionId: value.retainedVersionId, objectKey: artifacts.retained.objectKey, sha256: payloadSha256, byteLength: 32, sourceS3VersionId: artifacts.retained.versionId },
      absentAfterBackup: { artifactId: value.absentArtifactId, versionId: value.absentVersionId, objectKey: artifacts.absentAfterBackup.objectKey, sha256: payloadSha256, byteLength: 32, sourceS3VersionId: artifacts.absentAfterBackup.versionId },
    },
  }
}

function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function required(row: Document | null, name: string): Document {
  if (!row) throw new AgentStorageError('storage_not_ready', `validation fixture ${name} is absent`)
  return row
}
function assertFields(row: Document, expected: Readonly<Record<string, unknown>>, name: string): void {
  for (const [key, value] of Object.entries(expected)) if (!equal(row[key], value)) throw new AgentStorageError('storage_not_ready', `validation fixture ${name}.${key} does not match the frozen durable state`)
}
function custodyFromRow(row: Document): ObjectCustodyRecord {
  if (!(row.custodyCapturedAt instanceof Date)) throw new AgentStorageError('storage_not_ready', 'validation artifact custody timestamp is invalid')
  const record = { bucket: row.bucket, objectKey: row.objectKey, versionId: row.s3VersionId, eTag: row.eTag, sha256: row.sha256, byteLength: row.byteLength, kmsKeyId: row.kmsKeyId, capturedAt: row.custodyCapturedAt.toISOString() }
  if (Object.values(record).some(value => value === undefined || value === null || value === '')) throw new AgentStorageError('storage_not_ready', 'validation artifact current custody is incomplete')
  return record as ObjectCustodyRecord
}
function sourceCustodyFromRow(row: Document): ObjectCustodyRecord {
  const source = row.sourceObjectCustody
  if (!source) return custodyFromRow(row)
  const keys = Object.keys(source as Record<string, unknown>).sort()
  const expected = ['bucket', 'byteLength', 'capturedAt', 'eTag', 'kmsKeyId', 'objectKey', 'sha256', 'versionId'].sort()
  if (JSON.stringify(keys) !== JSON.stringify(expected) || Object.values(source as Record<string, unknown>).some(value => value === undefined || value === null || value === '')) {
    throw new AgentStorageError('storage_not_ready', 'validation artifact source custody is incomplete')
  }
  return source as ObjectCustodyRecord
}
function isDuplicateKey(error: unknown): boolean { return (error as { readonly code?: number }).code === 11000 }
async function insert(session: ClientSession, db: Db, collection: string, document: Document): Promise<void> { await db.collection(collection).insertOne(document, { session }) }

export async function seedValidationFixture(db: Db, operationId: string, payload: Uint8Array, artifacts: ValidationFixtureArtifactCustody, sourceResourceIds: Readonly<Record<string, string>>): Promise<ValidationFixtureReceipt> {
  assertOperationId(operationId)
  if (payload.byteLength !== 32) throw new AgentStorageError('invalid_storage_config', 'validation fixture payload must contain exactly 32 bytes')
  const payloadSha256 = sha256(payload)
  assertCustody(artifacts.retained, 'retained', validationFixtureRetainedObjectKey(operationId), payloadSha256, sourceResourceIds)
  assertCustody(artifacts.absentAfterBackup, 'absent-after-backup', validationFixtureAbsentAfterBackupObjectKey(operationId), payloadSha256, sourceResourceIds)
  if (artifacts.retained.versionId === artifacts.absentAfterBackup.versionId) throw new AgentStorageError('object_custody_mismatch', 'validation artifacts must use distinct immutable S3 versions')
  const value = ids(operationId)
  const semantic = stableSemantic(operationId, payloadSha256, artifacts)
  const occurredAt = await readServerTime(db)
  try {
    await withAgentTransaction(db, async session => {
      if (await db.collection('audit_events').findOne({ auditId: value.auditId }, { session })) return
      await insert(session, db, 'accounts', { ownerSubject: value.ownerSubject, displayName: 'Durability validation owner', state: 'active', createdAt: occurredAt })
      await insert(session, db, 'agents', { agentId: value.agentId, ownerSubject: value.ownerSubject, normalizedName: value.normalizedName, displayName: 'Durability validation agent', state: 'active', currentProfileRevision: 1, createdAt: occurredAt })
      await insert(session, db, 'agent_profile_revisions', { agentId: value.agentId, ownerSubject: value.ownerSubject, revision: 1, profileSha256: semantic.identity.profileSha256, displayName: 'Durability validation agent', remit: 'fixed storage durability validation only', createdAt: occurredAt })
      await insert(session, db, 'conversations', { conversationId: value.conversationId, agentId: value.agentId, ownerSubject: value.ownerSubject, title: 'Durability validation conversation', updatedAt: occurredAt })
      await insert(session, db, 'conversation_events', { eventId: value.eventId, conversationId: value.conversationId, agentId: value.agentId, sequence: 1, eventType: 'validation.fixture.message', payloadSha256, occurredAt })
      await insert(session, db, 'memories', { memoryId: value.memoryId, agentId: value.agentId, ownerSubject: value.ownerSubject, scope: 'agent', state: 'current', currentRevision: 1, contentSha256: semantic.history.memorySha256, updatedAt: occurredAt })
      await insert(session, db, 'memory_revisions', { memoryId: value.memoryId, revision: 1, contentSha256: semantic.history.memorySha256, createdAt: occurredAt })
      await insert(session, db, 'wakes', { wakeId: value.wakeId, agentId: value.agentId, conversationId: value.conversationId, ingressSequence: 1, state: 'queued', dispatchAllowed: true, queuedAt: occurredAt })
      await insert(session, db, 'wake_attempts', { attemptId: value.attemptId, wakeId: value.wakeId, generation: 1, state: 'awaiting_approval', dispatchAllowed: true, createdAt: occurredAt })
      await insert(session, db, 'work_requests', { workId: value.workId, agentId: value.agentId, attemptId: value.attemptId, workAttemptGeneration: 1, state: 'pending', dispatchAllowed: true, updatedAt: occurredAt })
      await insert(session, db, 'approvals', { approvalId: value.approvalId, attemptId: value.attemptId, actionHash: sha256(`approval\0${payloadSha256}`), state: 'pending', dispatchAllowed: true, expiresAt: new Date(occurredAt.getTime() + 30 * 24 * 60 * 60 * 1000) })
      await insert(session, db, 'work_requests', { workId: value.priorWorkId, agentId: value.agentId, workAttemptGeneration: 1, state: 'succeeded', dispatchAllowed: false, resultSha256: sha256(`result\0${payloadSha256}`), updatedAt: occurredAt })
      await insert(session, db, 'dispatch_intents', { intentId: value.priorIntentId, ownerSubject: value.ownerSubject, agentId: value.agentId, workId: value.priorWorkId, workAttemptGeneration: 1, intentHash: sha256(`intent\0${payloadSha256}`), state: 'accepted', dispatchAllowed: false, acceptedAt: occurredAt })
      await insert(session, db, 'artifact_versions', { versionId: value.retainedVersionId, artifactId: value.retainedArtifactId, ordinal: 1, agentId: value.agentId, state: 'ready', dispatchAllowed: true, createdAt: occurredAt, bucket: artifacts.retained.bucket, objectKey: artifacts.retained.objectKey, s3VersionId: artifacts.retained.versionId, eTag: artifacts.retained.eTag, sha256: artifacts.retained.sha256, byteLength: artifacts.retained.byteLength, kmsKeyId: artifacts.retained.kmsKeyId, custodyCapturedAt: new Date(artifacts.retained.capturedAt) })
      await insert(session, db, 'artifact_versions', { versionId: value.absentVersionId, artifactId: value.absentArtifactId, ordinal: 1, agentId: value.agentId, state: 'ready', dispatchAllowed: true, createdAt: occurredAt, bucket: artifacts.absentAfterBackup.bucket, objectKey: artifacts.absentAfterBackup.objectKey, s3VersionId: artifacts.absentAfterBackup.versionId, eTag: artifacts.absentAfterBackup.eTag, sha256: artifacts.absentAfterBackup.sha256, byteLength: artifacts.absentAfterBackup.byteLength, kmsKeyId: artifacts.absentAfterBackup.kmsKeyId, custodyCapturedAt: new Date(artifacts.absentAfterBackup.capturedAt) })
      await insert(session, db, 'audit_events', { auditId: value.priorLaunchAuditId, ownerSubject: value.ownerSubject, agentId: value.agentId, workId: value.priorWorkId, intentId: value.priorIntentId, eventType: 'executor.launch', occurredAt })
      await insert(session, db, 'audit_events', { auditId: value.auditId, ownerSubject: value.ownerSubject, eventType: 'storage.durability.validation', operationId, payloadSha256, payloadByteLength: 32, occurredAt })
    })
  } catch (error) {
    if (!isDuplicateKey(error)) throw error
  }
  return readValidationFixture(db, operationId, payloadSha256)
}

export async function readValidationFixture(db: Db, operationId: string, expectedPayloadSha256: string): Promise<ValidationFixtureReceipt> {
  assertOperationId(operationId)
  if (!/^[a-f0-9]{64}$/.test(expectedPayloadSha256)) throw new AgentStorageError('invalid_storage_config', 'validation expected payload SHA-256 is invalid')
  const value = ids(operationId)
  const [audit, launch, account, agent, profile, conversation, event, memory, memoryRevision, wake, attempt, work, approval, priorWork, intent, retained, absent] = await Promise.all([
    db.collection('audit_events').findOne({ auditId: value.auditId }), db.collection('audit_events').findOne({ auditId: value.priorLaunchAuditId }),
    db.collection('accounts').findOne({ ownerSubject: value.ownerSubject }), db.collection('agents').findOne({ agentId: value.agentId }),
    db.collection('agent_profile_revisions').findOne({ agentId: value.agentId, revision: 1 }), db.collection('conversations').findOne({ conversationId: value.conversationId }),
    db.collection('conversation_events').findOne({ eventId: value.eventId }), db.collection('memories').findOne({ memoryId: value.memoryId }),
    db.collection('memory_revisions').findOne({ memoryId: value.memoryId, revision: 1 }), db.collection('wakes').findOne({ wakeId: value.wakeId }),
    db.collection('wake_attempts').findOne({ attemptId: value.attemptId }), db.collection('work_requests').findOne({ workId: value.workId }),
    db.collection('approvals').findOne({ approvalId: value.approvalId }), db.collection('work_requests').findOne({ workId: value.priorWorkId }),
    db.collection('dispatch_intents').findOne({ intentId: value.priorIntentId }), db.collection('artifact_versions').findOne({ versionId: value.retainedVersionId }),
    db.collection('artifact_versions').findOne({ versionId: value.absentVersionId }),
  ])
  const auditRow = required(audit, 'audit event')
  if (auditRow.operationId !== operationId || auditRow.payloadSha256 !== expectedPayloadSha256 || auditRow.payloadByteLength !== 32 || !(auditRow.occurredAt instanceof Date)) throw new AgentStorageError('storage_not_ready', 'validation fixture payload binding does not match')
  const retainedRow = required(retained, 'retained artifact')
  const absentRow = required(absent, 'absent-after-backup artifact')
  const sourceArtifacts = { retained: sourceCustodyFromRow(retainedRow), absentAfterBackup: sourceCustodyFromRow(absentRow) }
  const semantic = stableSemantic(operationId, expectedPayloadSha256, sourceArtifacts)
  assertFields(required(account, 'account'), { ownerSubject: value.ownerSubject, state: 'active' }, 'account')
  assertFields(required(agent, 'agent'), { agentId: value.agentId, ownerSubject: value.ownerSubject, normalizedName: value.normalizedName, state: 'active', currentProfileRevision: 1 }, 'agent')
  assertFields(required(profile, 'profile'), { agentId: value.agentId, ownerSubject: value.ownerSubject, revision: 1, profileSha256: semantic.identity.profileSha256 }, 'profile')
  assertFields(required(conversation, 'conversation'), { conversationId: value.conversationId, agentId: value.agentId, ownerSubject: value.ownerSubject }, 'conversation')
  assertFields(required(event, 'conversation event'), { eventId: value.eventId, conversationId: value.conversationId, agentId: value.agentId, sequence: 1, eventType: 'validation.fixture.message', payloadSha256: expectedPayloadSha256 }, 'conversation event')
  assertFields(required(memory, 'memory'), { memoryId: value.memoryId, agentId: value.agentId, ownerSubject: value.ownerSubject, scope: 'agent', state: 'current', currentRevision: 1, contentSha256: semantic.history.memorySha256 }, 'memory')
  assertFields(required(memoryRevision, 'memory revision'), { memoryId: value.memoryId, revision: 1, contentSha256: semantic.history.memorySha256 }, 'memory revision')
  const wakeRow = required(wake, 'wake'); const attemptRow = required(attempt, 'wake attempt'); const workRow = required(work, 'work request'); const approvalRow = required(approval, 'approval')
  const priorWorkRow = required(priorWork, 'prior work request'); const intentRow = required(intent, 'prior dispatch intent'); const launchRow = required(launch, 'prior launch audit')
  assertFields(wakeRow, { wakeId: value.wakeId, agentId: value.agentId, conversationId: value.conversationId, ingressSequence: 1, state: 'queued' }, 'wake')
  assertFields(attemptRow, { attemptId: value.attemptId, wakeId: value.wakeId, generation: 1, state: 'awaiting_approval' }, 'wake attempt')
  assertFields(workRow, { workId: value.workId, agentId: value.agentId, attemptId: value.attemptId, workAttemptGeneration: 1, state: 'pending' }, 'work request')
  assertFields(approvalRow, { approvalId: value.approvalId, attemptId: value.attemptId, state: 'pending' }, 'approval')
  assertFields(priorWorkRow, { workId: value.priorWorkId, agentId: value.agentId, workAttemptGeneration: 1, state: 'succeeded' }, 'prior work request')
  assertFields(intentRow, { intentId: value.priorIntentId, ownerSubject: value.ownerSubject, agentId: value.agentId, workId: value.priorWorkId, workAttemptGeneration: 1, state: 'accepted' }, 'prior dispatch intent')
  assertFields(launchRow, { auditId: value.priorLaunchAuditId, ownerSubject: value.ownerSubject, agentId: value.agentId, workId: value.priorWorkId, intentId: value.priorIntentId, eventType: 'executor.launch' }, 'prior launch audit')
  assertFields(retainedRow, { versionId: value.retainedVersionId, artifactId: value.retainedArtifactId, ordinal: 1, agentId: value.agentId, state: 'ready', objectKey: semantic.artifacts.retained.objectKey, sha256: expectedPayloadSha256, byteLength: 32 }, 'retained artifact')
  const pendingRows = [wakeRow, attemptRow, workRow, approvalRow]
  const restoredRows = [...pendingRows, priorWorkRow, intentRow]
  const restored = restoredRows.every(row => row.recoveryMode === 'restored_observation' && row.dispatchAllowed === false)
  const live = pendingRows.every(row => row.recoveryMode === undefined && row.dispatchAllowed === true) && [priorWorkRow, intentRow].every(row => row.recoveryMode === undefined && row.dispatchAllowed === false)
  if (!restored && !live) throw new AgentStorageError('storage_not_ready', 'validation execution records have inconsistent recovery/dispatch state')
  assertFields(absentRow, {
    versionId: value.absentVersionId, artifactId: value.absentArtifactId, ordinal: 1, agentId: value.agentId,
    state: restored ? 'degraded_missing_object' : 'ready', objectKey: semantic.artifacts.absentAfterBackup.objectKey,
    sha256: expectedPayloadSha256, byteLength: 32, degradedReason: restored ? 'missing_version' : undefined,
    degradationProvenance: restored ? 'work12_injected_missing_version_after_exact_source_head' : undefined,
  }, 'absent-after-backup artifact')
  const retainedCurrent = custodyFromRow(retainedRow)
  const absentCurrent = custodyFromRow(absentRow)
  if (sourceArtifacts.retained.objectKey !== retainedCurrent.objectKey || sourceArtifacts.retained.sha256 !== retainedCurrent.sha256 || sourceArtifacts.retained.byteLength !== retainedCurrent.byteLength) throw new AgentStorageError('storage_not_ready', 'validation retained artifact source-to-current mapping changed bytes or object identity')
  if (!equal(sourceArtifacts.absentAfterBackup, absentCurrent)) throw new AgentStorageError('storage_not_ready', 'validation absent-after-backup artifact unexpectedly acquired a target mapping')
  const [dispatchIntentCount, executorLaunchCount, redispatchCount, eventCount, memoryRevisionCount] = await Promise.all([
    db.collection('dispatch_intents').countDocuments({ ownerSubject: value.ownerSubject }),
    db.collection('audit_events').countDocuments({ ownerSubject: value.ownerSubject, eventType: 'executor.launch' }),
    db.collection('audit_events').countDocuments({ ownerSubject: value.ownerSubject, eventType: 'executor.redispatch' }),
    db.collection('conversation_events').countDocuments({ conversationId: value.conversationId }),
    db.collection('memory_revisions').countDocuments({ memoryId: value.memoryId }),
  ])
  if (dispatchIntentCount !== 1 || executorLaunchCount !== 1 || redispatchCount !== 0 || eventCount !== 1 || memoryRevisionCount !== 1) throw new AgentStorageError('storage_not_ready', 'validation fixture history or exact dispatch boundary does not match')
  const retainedArtifact: ValidationFixtureArtifactReport = {
    kind: 'retained', artifactId: value.retainedArtifactId, versionId: value.retainedVersionId, state: 'ready', objectKey: retainedCurrent.objectKey,
    sha256: retainedCurrent.sha256, byteLength: 32, sourceBucket: sourceArtifacts.retained.bucket, sourceKmsKeyId: sourceArtifacts.retained.kmsKeyId,
    sourceS3VersionId: sourceArtifacts.retained.versionId, currentBucket: retainedCurrent.bucket, currentKmsKeyId: retainedCurrent.kmsKeyId,
    currentS3VersionId: retainedCurrent.versionId, versionMapped: !equal(sourceArtifacts.retained, retainedCurrent),
  }
  const absentArtifact: ValidationFixtureArtifactReport = {
    kind: 'absent_after_backup', artifactId: value.absentArtifactId, versionId: value.absentVersionId,
    state: restored ? 'degraded_missing_object' : 'ready', objectKey: absentCurrent.objectKey, sha256: absentCurrent.sha256, byteLength: 32,
    sourceBucket: sourceArtifacts.absentAfterBackup.bucket, sourceKmsKeyId: sourceArtifacts.absentAfterBackup.kmsKeyId,
    sourceS3VersionId: sourceArtifacts.absentAfterBackup.versionId, currentBucket: absentCurrent.bucket, currentKmsKeyId: absentCurrent.kmsKeyId,
    currentS3VersionId: absentCurrent.versionId, versionMapped: false, ...(restored ? {
      degradedReason: 'missing_version' as const,
      degradationProvenance: 'work12_injected_missing_version_after_exact_source_head' as const,
    } : {}),
  }
  return {
    schemaVersion: '1.0', operationId, payloadSha256: expectedPayloadSha256, payloadByteLength: 32, persistedAt: auditRow.occurredAt.toISOString(),
    semanticStateSha256: sha256(JSON.stringify(semantic)), identity: semantic.identity as ValidationFixtureReceipt['identity'], history: semantic.history as ValidationFixtureReceipt['history'],
    pending: { ...(semantic.pending as Omit<ValidationFixtureReceipt['pending'], 'dispatchAllowed'>), dispatchAllowed: live },
    priorExecution: semantic.priorExecution as ValidationFixtureReceipt['priorExecution'], artifacts: [retainedArtifact, absentArtifact],
    recoveryMode: restored ? 'restored_observation' : 'live', dispatchIntentCount: 1, executorLaunchCount: 1, redispatchCount: 0,
  }
}

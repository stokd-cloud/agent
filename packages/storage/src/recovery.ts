import { createHash, randomUUID } from 'node:crypto'
import type { Db } from 'mongodb'
import { AgentStorageError } from './errors.js'
import type { AgentBackupManifest } from './backup.js'
import type { ObjectRestoreMapping, ObjectRestoreTransport } from './object-custody.js'
import { readServerTime } from './readiness.js'
import { withAgentTransaction } from './transactions.js'

export type RecoveryMode = 'live' | 'restored_observation' | 'reconciled'

export interface RestoreReconciliationReport {
  readonly schemaVersion: '1.0'
  readonly restoreId: string
  readonly backupId: string
  readonly targetEnvironment: string
  readonly recoveryMode: 'restored_observation'
  readonly observedAt: string
  readonly executionRecordsMarked: number
  readonly dispatchIntentCountBefore: number
  readonly dispatchIntentCountAfter: number
  readonly redispatchCount: 0
  readonly dispatchBoundaryBefore: DispatchBoundarySnapshot
  readonly dispatchBoundaryAfter: DispatchBoundarySnapshot
  readonly readyObjectVersions: number
  readonly degradedObjectVersions: number
  readonly degraded: readonly { readonly objectKey: string; readonly versionId: string; readonly reason: string; readonly provenance?: 'work12_injected_missing_version_after_exact_source_head' }[]
  readonly objectVersionMappings: readonly ObjectRestoreMapping[]
  readonly stateSha256: string
}

export interface DispatchBoundarySnapshot {
  readonly accepted: number
  readonly launched: number
  readonly observedAt: string
}

export interface DispatchBoundaryObserver {
  snapshot(): Promise<DispatchBoundarySnapshot>
}

export class MongoDispatchBoundaryObserver implements DispatchBoundaryObserver {
  readonly db: Db
  constructor(db: Db) { this.db = db }
  async snapshot(): Promise<DispatchBoundarySnapshot> {
    const [accepted, launched, observedAt] = await Promise.all([
      this.db.collection('dispatch_intents').countDocuments({}),
      this.db.collection('audit_events').countDocuments({ eventType: 'executor.launch' }),
      readServerTime(this.db),
    ])
    return { accepted, launched, observedAt: observedAt.toISOString() }
  }
}

function assertDispatchBoundarySnapshot(value: DispatchBoundarySnapshot, name: string): void {
  if (!Number.isSafeInteger(value.accepted) || value.accepted < 0 || !Number.isSafeInteger(value.launched) || value.launched < 0 || Number.isNaN(Date.parse(value.observedAt))) {
    throw new AgentStorageError('restore_failed', `${name} is invalid`)
  }
}

function custodyEquals(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const fields = ['bucket', 'objectKey', 'versionId', 'eTag', 'sha256', 'byteLength', 'kmsKeyId', 'capturedAt'] as const
  return fields.every(field => (left as Record<string, unknown>)[field] === (right as Record<string, unknown>)[field])
}

function mappingKey(mapping: ObjectRestoreMapping): string {
  return `${mapping.source.bucket}\0${mapping.source.objectKey}\0${mapping.source.versionId}`
}

const EXECUTION_COLLECTIONS = ['wakes', 'wake_attempts', 'work_requests', 'approvals', 'dispatch_intents'] as const

async function recoveryStateHash(db: Db): Promise<string> {
  const hash = createHash('sha256')
  for (const collectionName of [...EXECUTION_COLLECTIONS, 'artifact_versions'] as const) {
    const rows = await db.collection(collectionName).find({}).sort({ _id: 1 }).toArray()
    hash.update(collectionName)
    hash.update('\0')
    hash.update(JSON.stringify(rows))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function reportFromLedger(record: Record<string, unknown>): RestoreReconciliationReport {
  return {
    schemaVersion: '1.0',
    restoreId: String(record.restoreId),
    backupId: String(record.backupId),
    targetEnvironment: String(record.targetEnvironment),
    recoveryMode: 'restored_observation',
    observedAt: String(record.observedAt),
    executionRecordsMarked: Number(record.executionRecordsMarked),
    dispatchIntentCountBefore: Number(record.dispatchIntentCountBefore),
    dispatchIntentCountAfter: Number(record.dispatchIntentCountAfter),
    redispatchCount: 0,
    dispatchBoundaryBefore: record.dispatchBoundaryBefore as DispatchBoundarySnapshot,
    dispatchBoundaryAfter: record.dispatchBoundaryAfter as DispatchBoundarySnapshot,
    readyObjectVersions: Number(record.readyObjectVersions),
    degradedObjectVersions: Number(record.degradedObjectVersions),
    degraded: record.degraded as RestoreReconciliationReport['degraded'],
    objectVersionMappings: record.objectVersionMappings as readonly ObjectRestoreMapping[],
    stateSha256: String(record.stateSha256),
  }
}

export async function enterRestoredObservationMode(input: {
  readonly db: Db
  readonly manifest: AgentBackupManifest
  readonly restoreId: string
  readonly targetEnvironment: string
  readonly objectTransport: ObjectRestoreTransport
  readonly dispatchObserver: DispatchBoundaryObserver
  readonly afterObjectRestored?: (completedCount: number) => Promise<void> | void
}): Promise<RestoreReconciliationReport> {
  if (input.targetEnvironment === input.manifest.sourceEnvironment) throw new AgentStorageError('restore_failed', 'restore target must be an isolated environment')
  const expectedObjectManifestSha256 = createHash('sha256').update(JSON.stringify(input.manifest.objects)).digest('hex')
  if (expectedObjectManifestSha256 !== input.manifest.objectManifestSha256) throw new AgentStorageError('restore_failed', 'object manifest checksum mismatch')
  const observedAt = await readServerTime(input.db)
  const leaseToken = randomUUID()
  const leaseExpiresAt = new Date(observedAt.getTime() + 300_000)
  const ledger = input.db.collection('restore_reconciliations')
  const existing = await ledger.findOne({ restoreId: input.restoreId })
  if (existing && (existing.backupId !== input.manifest.backupId || existing.targetEnvironment !== input.targetEnvironment || existing.objectManifestSha256 !== input.manifest.objectManifestSha256)) {
    throw new AgentStorageError('restore_failed', 'deterministic restore ledger conflicts with this backup or target')
  }
  if (existing && (existing.state === 'observation_only' || existing.state === 'reconciled')) {
    const [stateSha256, boundary] = await Promise.all([recoveryStateHash(input.db), input.dispatchObserver.snapshot()])
    const after = existing.dispatchBoundaryAfter as DispatchBoundarySnapshot | undefined
    assertDispatchBoundarySnapshot(boundary, 'current completed-restore dispatch boundary')
    if (after) assertDispatchBoundarySnapshot(after, 'recorded completed-restore dispatch boundary')
    if (!existing.stateSha256 || stateSha256 !== existing.stateSha256 || !after || boundary.accepted !== after.accepted || boundary.launched !== after.launched) {
      throw new AgentStorageError('restore_failed', 'completed restore ledger no longer matches target state or dispatch boundary')
    }
    return reportFromLedger(existing)
  }
  if (!existing) {
    try {
      await ledger.insertOne({
        restoreId: input.restoreId,
        backupId: input.manifest.backupId,
        targetEnvironment: input.targetEnvironment,
        objectManifestSha256: input.manifest.objectManifestSha256,
        state: 'restoring',
        leaseToken,
        leaseExpiresAt,
        startedAt: observedAt,
        executionRecordsMarked: 0,
        degraded: [],
        objectVersionMappings: [],
      })
    } catch (error) {
      throw new AgentStorageError('restore_failed', 'another restore created the deterministic ledger first', { cause: error instanceof Error ? error.message : String(error) })
    }
  } else {
    const acquired = await ledger.updateOne(
      {
        restoreId: input.restoreId,
        objectManifestSha256: input.manifest.objectManifestSha256,
        $or: [{ state: 'interrupted' }, { state: 'restoring', leaseExpiresAt: { $lte: observedAt } }],
      },
      { $set: { state: 'restoring', leaseToken, leaseExpiresAt, resumedAt: observedAt } },
    )
    if (acquired.matchedCount !== 1) throw new AgentStorageError('restore_failed', 'another restore holds the backup/target reconciliation lease')
  }

  try {
    const dispatchBoundaryBefore = await input.dispatchObserver.snapshot()
    assertDispatchBoundarySnapshot(dispatchBoundaryBefore, 'dispatch boundary before restore')
    const before = await input.db.collection('dispatch_intents').countDocuments({})
    let marked = 0
    await withAgentTransaction(input.db, async session => {
      for (const collectionName of EXECUTION_COLLECTIONS) {
        const result = await input.db.collection(collectionName).updateMany(
          {},
          { $set: { recoveryMode: 'restored_observation', dispatchAllowed: false, restoreId: input.restoreId, restoredAt: observedAt } },
          { session },
        )
        marked += result.modifiedCount
      }
      return true
    })
    const markedProgress = await ledger.updateOne(
      { restoreId: input.restoreId, leaseToken, state: 'restoring' },
      { $inc: { executionRecordsMarked: marked }, $set: { updatedAt: observedAt } },
    )
    if (markedProgress.matchedCount !== 1) throw new AgentStorageError('restore_failed', 'restore reconciliation lease was fenced while recording execution state')
    const prior = await ledger.findOne({ restoreId: input.restoreId, leaseToken })
    const degraded = [...((prior?.degraded as { objectKey: string; versionId: string; reason: string; provenance?: 'work12_injected_missing_version_after_exact_source_head' }[] | undefined) ?? [])]
    const objectVersionMappings = [...((prior?.objectVersionMappings as ObjectRestoreMapping[] | undefined) ?? [])]
    const degradedKeys = new Set(degraded.map(value => `${value.objectKey}\0${value.versionId}`))
    const mappingKeys = new Set(objectVersionMappings.map(mappingKey))
    const addDegraded = (value: { objectKey: string; versionId: string; reason: string; provenance?: 'work12_injected_missing_version_after_exact_source_head' }): void => {
      const key = `${value.objectKey}\0${value.versionId}`
      if (!degradedKeys.has(key)) { degradedKeys.add(key); degraded.push(value) }
    }
    const removeDegraded = (objectKey: string, versionId: string): void => {
      for (let index = degraded.length - 1; index >= 0; index -= 1) {
        const value = degraded[index]!
        if (value.objectKey === objectKey && value.versionId === versionId) degraded.splice(index, 1)
      }
      degradedKeys.clear()
      for (const value of degraded) degradedKeys.add(`${value.objectKey}\0${value.versionId}`)
    }
    const manifestKeys = new Set(input.manifest.objects.map(record => `${record.objectKey}\0${record.versionId}`))
    const omittedReadyRows = await input.db.collection('artifact_versions').find({ state: 'ready' }).toArray()
    for (const row of omittedReadyRows) {
      const key = `${String(row.objectKey)}\0${String(row.s3VersionId)}`
      const sourceCustody = row.sourceObjectCustody
      const mappedManifestMember = input.manifest.objects.some(record => custodyEquals(sourceCustody, record))
      if (manifestKeys.has(key) || mappedManifestMember) continue
      addDegraded({ objectKey: String(row.objectKey), versionId: String(row.s3VersionId), reason: 'not_in_backup_manifest' })
      await input.db.collection('artifact_versions').updateOne(
        { _id: row._id },
        { $set: { state: 'degraded_missing_object', recoveryMode: 'restored_observation', dispatchAllowed: false, restoreId: input.restoreId, degradedReason: 'not_in_backup_manifest' }, $unset: { degradationProvenance: '' } },
      )
    }
    let completedCount = 0
    const renewLease = async (): Promise<void> => {
      const heartbeatAt = await readServerTime(input.db)
      const heartbeat = await ledger.updateOne(
        { restoreId: input.restoreId, leaseToken, state: 'restoring' },
        { $set: { leaseExpiresAt: new Date(heartbeatAt.getTime() + 300_000), updatedAt: heartbeatAt } },
      )
      if (heartbeat.matchedCount !== 1) throw new AgentStorageError('restore_failed', 'restore reconciliation lease was fenced during object transfer')
    }
    for (const record of input.manifest.objects) {
      let heartbeatFailure: unknown
      let heartbeatRunning = false
      const timer = setInterval(() => {
        if (heartbeatRunning || heartbeatFailure) return
        heartbeatRunning = true
        void renewLease().catch(error => { heartbeatFailure = error }).finally(() => { heartbeatRunning = false })
      }, 30_000)
      let result
      try {
        result = await input.objectTransport.restoreVersion(record, renewLease)
      } finally {
        clearInterval(timer)
      }
      if (heartbeatFailure) throw heartbeatFailure
      if (result.status === 'copied') {
        const target = result.mapping.target
        const rows = await input.db.collection('artifact_versions').find({
          $or: [
            { objectKey: record.objectKey, s3VersionId: record.versionId, state: 'ready' },
            { objectKey: target.objectKey, s3VersionId: target.versionId, 'sourceObjectCustody.bucket': record.bucket, 'sourceObjectCustody.objectKey': record.objectKey, 'sourceObjectCustody.versionId': record.versionId },
          ],
        }).toArray()
        if (rows.length !== 1) throw new AgentStorageError('object_custody_mismatch', 'backup object does not resolve to exactly one source or resumed target database row', { objectKey: record.objectKey, versionId: record.versionId, matchedRows: rows.length })
        const row = rows[0]!
        const alreadyMapped = row.s3VersionId === target.versionId
        if (alreadyMapped) {
          const rowTarget = { bucket: row.bucket, objectKey: row.objectKey, versionId: row.s3VersionId, eTag: row.eTag, sha256: row.sha256, byteLength: row.byteLength, kmsKeyId: row.kmsKeyId, capturedAt: row.custodyCapturedAt instanceof Date ? row.custodyCapturedAt.toISOString() : row.custodyCapturedAt }
          if (!custodyEquals(row.sourceObjectCustody, record) || !custodyEquals(rowTarget, target)) throw new AgentStorageError('object_custody_mismatch', 'resumed database object mapping differs from exact source/target custody')
          await input.db.collection('artifact_versions').updateOne(
            { _id: row._id },
            { $set: { state: 'ready', recoveryMode: 'restored_observation', dispatchAllowed: false, restoreId: input.restoreId }, $unset: { degradedReason: '', degradationProvenance: '' } },
          )
        } else {
          const update = await input.db.collection('artifact_versions').updateOne(
            { _id: row._id, objectKey: record.objectKey, s3VersionId: record.versionId, state: 'ready' },
            { $set: {
              bucket: target.bucket,
              objectKey: target.objectKey,
              s3VersionId: target.versionId,
              eTag: target.eTag,
              sha256: target.sha256,
              byteLength: target.byteLength,
              kmsKeyId: target.kmsKeyId,
              custodyCapturedAt: new Date(target.capturedAt),
              sourceObjectCustody: record,
              recoveryMode: 'restored_observation',
              dispatchAllowed: false,
              restoreId: input.restoreId,
            } },
          )
          if (update.matchedCount !== 1) throw new AgentStorageError('object_custody_mismatch', 'source database object changed during restore reconciliation')
        }
        const key = mappingKey(result.mapping)
        if (!mappingKeys.has(key)) { mappingKeys.add(key); objectVersionMappings.push(result.mapping) }
        removeDegraded(record.objectKey, record.versionId)
      } else {
        const transportReason = result.reason ?? 'object_custody_mismatch'
        const update = await input.db.collection('artifact_versions').updateOne(
          { objectKey: record.objectKey, s3VersionId: record.versionId },
          {
            $set: {
              state: 'degraded_missing_object', recoveryMode: 'restored_observation', dispatchAllowed: false,
              restoreId: input.restoreId, degradedReason: transportReason,
              ...(result.provenance ? { degradationProvenance: result.provenance } : {}),
            },
            ...(result.provenance ? {} : { $unset: { degradationProvenance: '' } }),
          },
        )
        const reason = update.matchedCount === 1 ? transportReason : `${transportReason}:missing_database_reference`
        addDegraded({ objectKey: record.objectKey, versionId: record.versionId, reason, ...(result.provenance ? { provenance: result.provenance } : {}) })
      }
      completedCount += 1
      const heartbeatAt = await readServerTime(input.db)
      const progress = await ledger.updateOne(
        { restoreId: input.restoreId, leaseToken, state: 'restoring' },
        { $set: { objectVersionMappings, degraded, leaseExpiresAt: new Date(heartbeatAt.getTime() + 300_000), updatedAt: heartbeatAt } },
      )
      if (progress.matchedCount !== 1) throw new AgentStorageError('restore_failed', 'restore reconciliation lease was fenced')
      await input.afterObjectRestored?.(completedCount)
    }
    const after = await input.db.collection('dispatch_intents').countDocuments({})
    if (after !== before) throw new AgentStorageError('restore_failed', 'restore reconciliation created a dispatch intent', { before, after })
    const dispatchBoundaryAfter = await input.dispatchObserver.snapshot()
    assertDispatchBoundarySnapshot(dispatchBoundaryAfter, 'dispatch boundary after restore')
    if (dispatchBoundaryAfter.accepted !== dispatchBoundaryBefore.accepted || dispatchBoundaryAfter.launched !== dispatchBoundaryBefore.launched) {
      throw new AgentStorageError('restore_failed', 'restore reconciliation crossed the dispatch boundary', { dispatchBoundaryBefore, dispatchBoundaryAfter })
    }
    const totalMarked = (await Promise.all(EXECUTION_COLLECTIONS.map(collectionName => input.db.collection(collectionName).countDocuments({
      restoreId: input.restoreId,
      recoveryMode: 'restored_observation',
      dispatchAllowed: false,
    })))).reduce((total, value) => total + value, 0)
    const report: RestoreReconciliationReport = {
    schemaVersion: '1.0',
    restoreId: input.restoreId,
    backupId: input.manifest.backupId,
    targetEnvironment: input.targetEnvironment,
    recoveryMode: 'restored_observation',
    observedAt: observedAt.toISOString(),
    executionRecordsMarked: totalMarked,
    dispatchIntentCountBefore: before,
    dispatchIntentCountAfter: after,
    redispatchCount: 0,
    dispatchBoundaryBefore,
    dispatchBoundaryAfter,
    readyObjectVersions: objectVersionMappings.length,
    degradedObjectVersions: degraded.length,
    degraded,
    objectVersionMappings,
    stateSha256: await recoveryStateHash(input.db),
    }
    const finalized = await ledger.updateOne(
      { restoreId: input.restoreId, leaseToken, state: 'restoring' },
      { $set: { ...report, state: 'observation_only', objectManifestSha256: input.manifest.objectManifestSha256 }, $unset: { leaseToken: '', leaseExpiresAt: '' } },
    )
    if (finalized.matchedCount !== 1) throw new AgentStorageError('restore_failed', 'restore reconciliation lost its ledger lease before finalization')
    return report
  } catch (error) {
    const failedAt = await readServerTime(input.db).catch(() => new Date())
    await ledger.updateOne(
      { restoreId: input.restoreId, leaseToken },
      { $set: { state: 'interrupted', failedAt, errorCode: error instanceof AgentStorageError ? error.code : 'restore_failed' }, $unset: { leaseToken: '', leaseExpiresAt: '' } },
    ).catch(() => undefined)
    throw error
  }
}

export async function recordExplicitReconciliation(db: Db, restoreId: string, expectedStateSha256: string, authorizationId: string): Promise<void> {
  if (!authorizationId) throw new AgentStorageError('restore_failed', 'explicit reconciliation authorization is required')
  const existing = await db.collection('restore_reconciliations').findOne({ restoreId, state: 'observation_only' })
  if (!existing || existing.stateSha256 !== expectedStateSha256) throw new AgentStorageError('restore_failed', 'restore report changed or is already reconciled', { restoreId })
  const now = await readServerTime(db)
  const result = await db.collection('restore_reconciliations').updateOne(
    { restoreId, state: 'observation_only', stateSha256: expectedStateSha256 },
    { $set: { state: 'reconciled', authorizationId, reconciledAt: now } },
  )
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) throw new AgentStorageError('restore_failed', 'reconciliation authorization lost a concurrent state race', { restoreId })
}

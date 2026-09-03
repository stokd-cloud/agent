import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { MongoClient, type Db } from 'mongodb'
import { agentDatabaseName, MONGODB_FCV, MONGODB_SERVER_VERSION } from './config.js'
import { AgentStorageError } from './errors.js'
import { readReadyObjectCustody, type ObjectCustodyRecord } from './object-custody.js'
import { readServerTime } from './readiness.js'

export const MONGODB_DATABASE_TOOLS_VERSION = '100.14.0' as const
export const AGENT_RESOURCE_ID_KEYS = ['artifactBucket', 'backupBucket', 'databaseVolumeId', 'kmsKeyArn', 'mongoInstanceId'] as const
export const AGENT_PRINCIPAL_KINDS = ['runtime', 'migration', 'backup'] as const
export type AgentPrincipalKind = typeof AGENT_PRINCIPAL_KINDS[number]
export type AgentSecretVersionIds = Readonly<Record<AgentPrincipalKind, string>>

export function assertAgentResourceIds(value: Readonly<Record<string, string>>, name: string, errorCode: 'backup_failed' | 'restore_failed' = 'backup_failed'): void {
  const actual = Object.keys(value).sort()
  const expected = [...AGENT_RESOURCE_ID_KEYS].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]) || Object.values(value).some(child => typeof child !== 'string' || child.length === 0)) {
    throw new AgentStorageError(errorCode, `${name} must contain exactly the frozen Agent resource identity keys`)
  }
}

export function assertAgentSecretVersionIds(value: Readonly<Record<string, string>>, name: string, errorCode: 'backup_failed' | 'restore_failed' = 'backup_failed'): asserts value is AgentSecretVersionIds {
  const actual = Object.keys(value).sort()
  const expected = [...AGENT_PRINCIPAL_KINDS].sort()
  if (
    actual.length !== expected.length || actual.some((key, index) => key !== expected[index]) ||
    Object.values(value).some(child => typeof child !== 'string' || !/^[A-Za-z0-9._-]{1,256}$/.test(child))
  ) throw new AgentStorageError(errorCode, `${name} must contain exactly the frozen Agent principal secret VersionIds`)
}

export interface BackupAdmissionQuiesceProof {
  readonly schemaVersion: '1.0'
  readonly proofId: string
  readonly sourceEnvironment: string
  readonly apiDesiredCount: 0
  readonly apiRunningCount: 0
  readonly observedAt: string
  readonly expiresAt: string
  readonly sourceResourceIds: Readonly<Record<string, string>>
}

export interface AgentBackupManifest {
  readonly schemaVersion: '1.0'
  readonly backupId: string
  readonly sourceEnvironment: string
  readonly sourceDatabase: string
  readonly sourceReplicaSet: string
  readonly sourceResourceIds: Readonly<Record<string, string>>
  readonly sourceSecretVersionIds: AgentSecretVersionIds
  readonly observedMemberEndpoint: string
  readonly observedDatabaseInventory: readonly string[]
  readonly admissionQuiesceProof: BackupAdmissionQuiesceProof
  readonly recoveryMethod: {
    readonly kind: 'owned-loopback-noauth-maintenance'
    readonly version: '1.0'
    readonly requiresStoppedService: true
    readonly noSteadyStateRecoveryPrincipal: true
  }
  readonly dumpStartedAt: string
  readonly restorePoint: {
    readonly kind: 'observed-oplog-dump-interval'
    readonly startedAt: string
    readonly completedAt: string
  }
  readonly serverVersion: string
  readonly featureCompatibilityVersion: string
  readonly databaseToolsVersion: string
  readonly archive: {
    readonly format: 'mongodump-archive-gzip'
    readonly fullReplicaSet: true
    readonly oplogIncluded: true
    readonly sha256: string
    readonly byteLength: number
    readonly custody: ObjectCustodyRecord
  }
  readonly objects: readonly ObjectCustodyRecord[]
  readonly objectManifestSha256: string
  readonly custodyMode: 'local_evidence' | 's3_versioned'
}

export interface AgentBackupReceipt {
  readonly manifest: AgentBackupManifest
  readonly manifestBytes: Uint8Array
  readonly manifestSha256: string
  readonly manifestCustody: ObjectCustodyRecord
  readonly transientArchivePath: string
}

export interface BackupResourceIdentityProbe {
  inspect(): Promise<Readonly<Record<string, string>>>
}

export interface BackupAdmissionQuiesceProbe {
  inspect(): Promise<Omit<BackupAdmissionQuiesceProof, 'apiDesiredCount' | 'apiRunningCount'> & { readonly apiDesiredCount: number; readonly apiRunningCount: number }>
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
function jsonSha256(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function canonicalObjects(value: readonly ObjectCustodyRecord[]): string {
  return JSON.stringify([...value].sort((left, right) => `${left.bucket}/${left.objectKey}/${left.versionId}`.localeCompare(`${right.bucket}/${right.objectKey}/${right.versionId}`)))
}
function canonicalRecord(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRecord).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalRecord(child)}`).join(',')}}`
  return JSON.stringify(value)
}

export function assertDatabaseToolVersion(binaryPath: string, commandName: 'mongodump' | 'mongorestore'): void {
  if (!resolve(binaryPath).startsWith('/')) throw new AgentStorageError('backup_failed', `${commandName} path must be absolute`)
  const result = spawnSync(binaryPath, ['--version'], { encoding: 'utf8' })
  const expected = `${commandName} version: ${MONGODB_DATABASE_TOOLS_VERSION}`
  if (result.status !== 0 || !result.stdout.includes(expected)) {
    throw new AgentStorageError('backup_failed', `${commandName} ${MONGODB_DATABASE_TOOLS_VERSION} is required`, { observed: result.stdout.trim() })
  }
}

function assertFullReplicaSetUri(uri: string): void {
  let parsed: URL
  try { parsed = new URL(uri) } catch { throw new AgentStorageError('backup_failed', 'backup URI is invalid') }
  if (parsed.protocol !== 'mongodb:' || !parsed.username || !parsed.password) throw new AgentStorageError('backup_failed', 'backup URI must be an authenticated mongodb URI')
  const selectedDatabase = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (selectedDatabase) throw new AgentStorageError('backup_failed', 'full replica-set backup URI may not select any database; use authSource=admin')
  if (parsed.searchParams.get('authSource') !== 'admin') throw new AgentStorageError('backup_failed', 'full replica-set backup must use the dedicated admin-authenticated backup principal')
  if (!parsed.searchParams.get('replicaSet')) throw new AgentStorageError('backup_failed', 'backup URI must pin the replica set')
}

function runToolWithConfig(binaryPath: string, uri: string, args: readonly string[], temporaryParent: string): { readonly stdout: string; readonly stderr: string } {
  const temporary = mkdtempSync(join(temporaryParent, '.agent-mongo-tool-'))
  const configPath = join(temporary, 'config.yml')
  try {
    writeFileSync(configPath, `uri: ${JSON.stringify(uri)}\n`, { mode: 0o600 })
    chmodSync(configPath, 0o600)
    const result = spawnSync(binaryPath, ['--config', configPath, ...args], { encoding: 'utf8', env: { ...process.env, HOME: temporary } })
    if (result.status !== 0) throw new AgentStorageError('backup_failed', `${binaryPath.split('/').at(-1)} failed`, { exitCode: result.status, stderr: result.stderr })
    return { stdout: result.stdout, stderr: result.stderr }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export async function createReplicaSetBackup(input: {
  readonly db: Db
  readonly backupUri: string
  readonly mongodumpPath: string
  readonly archivePath: string
  readonly sourceEnvironment: string
  readonly sourceDatabase: string
  readonly sourceResourceIds: Readonly<Record<string, string>>
  readonly sourceSecretVersionIds: AgentSecretVersionIds
  readonly sourceResourceIdentityProbe: BackupResourceIdentityProbe
  readonly admissionQuiesceProof: BackupAdmissionQuiesceProof
  readonly admissionQuiesceProbe: BackupAdmissionQuiesceProbe
  readonly objects: readonly ObjectCustodyRecord[]
  readonly custodyMode: AgentBackupManifest['custodyMode']
  readonly publishArchive: (archive: { readonly path: string; readonly sha256: string; readonly byteLength: number }) => Promise<ObjectCustodyRecord>
  readonly publishManifest: (manifest: { readonly bytes: Uint8Array; readonly sha256: string; readonly byteLength: number }) => Promise<ObjectCustodyRecord>
}): Promise<AgentBackupReceipt> {
  assertDatabaseToolVersion(input.mongodumpPath, 'mongodump')
  assertFullReplicaSetUri(input.backupUri)
  if (input.sourceDatabase !== agentDatabaseName(input.sourceEnvironment) || input.db.databaseName !== input.sourceDatabase) {
    throw new AgentStorageError('backup_failed', 'source environment, database and connected DB do not identify the same isolated Agent database', { sourceEnvironment: input.sourceEnvironment, sourceDatabase: input.sourceDatabase, connectedDatabase: input.db.databaseName })
  }
  const observedSourceResourceIds = await input.sourceResourceIdentityProbe.inspect()
  assertAgentResourceIds(input.sourceResourceIds, 'declared source resource IDs')
  assertAgentSecretVersionIds(input.sourceSecretVersionIds, 'declared source principal secret VersionIds')
  assertAgentResourceIds(observedSourceResourceIds, 'observed source resource IDs')
  const sorted = (value: Readonly<Record<string, string>>): string => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  if (
    Object.keys(observedSourceResourceIds).length === 0 || Object.values(observedSourceResourceIds).some(value => typeof value !== 'string' || value.length === 0) ||
    sorted(observedSourceResourceIds) !== sorted(input.sourceResourceIds)
  ) {
    throw new AgentStorageError('backup_failed', 'source resource IDs are required')
  }
  const observedQuiesceProof = await input.admissionQuiesceProbe.inspect()
  if (canonicalRecord(observedQuiesceProof) !== canonicalRecord(input.admissionQuiesceProof)) throw new AgentStorageError('backup_failed', 'API admission quiesce proof changed during backup preflight')
  const proof = input.admissionQuiesceProof
  const proofObservedAt = new Date(proof.observedAt)
  const proofExpiresAt = new Date(proof.expiresAt)
  if (
    proof.schemaVersion !== '1.0' || !/^aqp_[A-Za-z0-9_-]{8,96}$/.test(proof.proofId) || proof.sourceEnvironment !== input.sourceEnvironment ||
    proof.apiDesiredCount !== 0 || proof.apiRunningCount !== 0 || Number.isNaN(proofObservedAt.getTime()) || Number.isNaN(proofExpiresAt.getTime()) ||
    proofExpiresAt <= proofObservedAt || sorted(proof.sourceResourceIds) !== sorted(observedSourceResourceIds)
  ) throw new AgentStorageError('backup_failed', 'backup requires a current exact zero-admission API quiesce proof for the source resources')
  const archivePath = resolve(input.archivePath)
  const inspector = new MongoClient(input.backupUri, { appName: 'stokd-agent-backup-inspector', readPreference: 'primary', serverSelectionTimeoutMS: 10_000 })
  let serverVersion = ''
  let featureCompatibilityVersion = ''
  let sourceReplicaSet = ''
  let observedMemberEndpoint = ''
  let observedDatabaseInventory: string[] = []
  let dumpStartedAt: Date
  let restorePoint: Date
  let objects: readonly ObjectCustodyRecord[] = []
  try {
    await inspector.connect()
    const admin = inspector.db('admin')
    const hello = await admin.command({ hello: 1 }) as { readonly setName?: string; readonly me?: string; readonly localTime?: Date; readonly isWritablePrimary?: boolean }
    const buildInfo = await admin.command({ buildInfo: 1 }) as { readonly version?: string }
    const fcv = await admin.command({ getParameter: 1, featureCompatibilityVersion: 1 }) as { readonly featureCompatibilityVersion?: { readonly version?: string } }
    const databaseList = await admin.admin().listDatabases({ nameOnly: true })
    observedDatabaseInventory = databaseList.databases.map(value => value.name).sort()
    const applicationDatabases = observedDatabaseInventory.filter(name => !['admin', 'config', 'local'].includes(name))
    if (applicationDatabases.length !== 1 || applicationDatabases[0] !== input.sourceDatabase) {
      throw new AgentStorageError('backup_failed', 'full-instance --oplog backup requires a dedicated Agent-only replica set', { observedDatabaseInventory })
    }
    serverVersion = buildInfo.version ?? ''
    const rawFcv = fcv.featureCompatibilityVersion
    featureCompatibilityVersion = rawFcv?.version ?? ''
    sourceReplicaSet = hello.setName ?? ''
    observedMemberEndpoint = hello.me ?? ''
    if (serverVersion !== MONGODB_SERVER_VERSION || featureCompatibilityVersion !== MONGODB_FCV || !sourceReplicaSet || !observedMemberEndpoint || hello.isWritablePrimary !== true) {
      throw new AgentStorageError('backup_failed', 'backup source does not match pinned writable MongoDB replica-set requirements', { serverVersion, featureCompatibilityVersion, sourceReplicaSet, observedMemberEndpoint })
    }
    const connectedHello = await input.db.admin().command({ hello: 1 }) as { readonly setName?: string; readonly me?: string }
    if (connectedHello.setName !== sourceReplicaSet || connectedHello.me !== observedMemberEndpoint) {
      throw new AgentStorageError('backup_failed', 'manifest database connection is not the inspected backup replica set', { connectedReplicaSet: connectedHello.setName, connectedMemberEndpoint: connectedHello.me, sourceReplicaSet, observedMemberEndpoint })
    }
    const objectsBefore = await readReadyObjectCustody(input.db)
    if (canonicalObjects(objectsBefore) !== canonicalObjects(input.objects)) throw new AgentStorageError('backup_failed', 'caller object custody changed before the dump restore-point interval')
    dumpStartedAt = await readServerTime(admin)
    if (proofObservedAt > dumpStartedAt || dumpStartedAt.getTime() - proofObservedAt.getTime() > 300_000 || proofExpiresAt <= dumpStartedAt) throw new AgentStorageError('backup_failed', 'API admission quiesce proof is stale or not yet valid at dump start')
    runToolWithConfig(input.mongodumpPath, input.backupUri, [`--archive=${archivePath}`, '--gzip', '--oplog'], dirname(archivePath))
    restorePoint = await readServerTime(admin)
    if (proofExpiresAt <= restorePoint) throw new AgentStorageError('backup_failed', 'API admission quiesce proof expired before the dump restore-point interval completed')
    const objectsAfter = await readReadyObjectCustody(input.db)
    if (canonicalObjects(objectsBefore) !== canonicalObjects(objectsAfter)) {
      throw new AgentStorageError('backup_failed', 'ready object custody changed during the dump restore-point interval; archive publication refused')
    }
    const finalQuiesceProof = await input.admissionQuiesceProbe.inspect()
    if (canonicalRecord(finalQuiesceProof) !== canonicalRecord(proof)) throw new AgentStorageError('backup_failed', 'API admission quiesce proof changed before archive publication')
    objects = objectsAfter
  } finally {
    await inspector.close().catch(() => undefined)
  }
  const archiveStat = statSync(archivePath)
  if (!archiveStat.isFile() || archiveStat.size === 0) throw new AgentStorageError('backup_failed', 'mongodump did not create a nonempty archive')
  const archiveSha256 = await fileSha256(archivePath)
  const archiveCustody = await input.publishArchive({ path: archivePath, sha256: archiveSha256, byteLength: archiveStat.size })
  if (archiveCustody.sha256 !== archiveSha256 || archiveCustody.byteLength !== archiveStat.size) {
    throw new AgentStorageError('object_custody_mismatch', 'published backup archive custody does not match produced bytes', { archiveSha256, archiveByteLength: archiveStat.size, custody: archiveCustody })
  }
  if (archiveCustody.bucket !== observedSourceResourceIds.backupBucket || archiveCustody.kmsKeyId !== observedSourceResourceIds.kmsKeyArn) throw new AgentStorageError('object_custody_mismatch', 'backup archive custody is outside the frozen source backup bucket or KMS key')
  for (const record of objects) if (record.bucket !== observedSourceResourceIds.artifactBucket || record.kmsKeyId !== observedSourceResourceIds.kmsKeyArn) throw new AgentStorageError('object_custody_mismatch', 'ready artifact custody is outside the frozen source artifact bucket or KMS key')
  objects = [...objects].sort((left, right) => `${left.bucket}/${left.objectKey}/${left.versionId}`.localeCompare(`${right.bucket}/${right.objectKey}/${right.versionId}`))
  const manifest: AgentBackupManifest = {
    schemaVersion: '1.0',
    backupId: `bkp_${randomUUID().replaceAll('-', '')}`,
    sourceEnvironment: input.sourceEnvironment,
    sourceDatabase: input.sourceDatabase,
    sourceReplicaSet,
    sourceResourceIds: observedSourceResourceIds,
    sourceSecretVersionIds: input.sourceSecretVersionIds,
    observedMemberEndpoint,
    observedDatabaseInventory,
    admissionQuiesceProof: proof,
    recoveryMethod: { kind: 'owned-loopback-noauth-maintenance', version: '1.0', requiresStoppedService: true, noSteadyStateRecoveryPrincipal: true },
    dumpStartedAt: dumpStartedAt!.toISOString(),
    restorePoint: { kind: 'observed-oplog-dump-interval', startedAt: dumpStartedAt!.toISOString(), completedAt: restorePoint.toISOString() },
    serverVersion,
    featureCompatibilityVersion,
    databaseToolsVersion: MONGODB_DATABASE_TOOLS_VERSION,
    archive: {
      format: 'mongodump-archive-gzip',
      fullReplicaSet: true,
      oplogIncluded: true,
      sha256: archiveSha256,
      byteLength: archiveStat.size,
      custody: archiveCustody,
    },
    objects,
    objectManifestSha256: jsonSha256(objects),
    custodyMode: input.custodyMode,
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
  const manifestCustody = await input.publishManifest({ bytes: manifestBytes, sha256: manifestSha256, byteLength: manifestBytes.byteLength })
  if (manifestCustody.sha256 !== manifestSha256 || manifestCustody.byteLength !== manifestBytes.byteLength) {
    throw new AgentStorageError('object_custody_mismatch', 'published backup manifest custody does not match produced bytes', { manifestSha256, manifestByteLength: manifestBytes.byteLength, custody: manifestCustody })
  }
  if (manifestCustody.bucket !== observedSourceResourceIds.backupBucket || manifestCustody.kmsKeyId !== observedSourceResourceIds.kmsKeyArn) throw new AgentStorageError('object_custody_mismatch', 'backup manifest custody is outside the frozen source backup bucket or KMS key')
  await input.db.collection('backup_manifests').insertOne({ ...manifest, manifestSha256, manifestCustody })
  return { manifest, manifestBytes, manifestSha256, manifestCustody, transientArchivePath: archivePath }
}

export const internalMongoTool = { runToolWithConfig, fileSha256 }

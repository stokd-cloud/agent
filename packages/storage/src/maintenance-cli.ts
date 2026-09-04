import { closeSync, createReadStream, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { DescribeServicesCommand, ECSClient } from '@aws-sdk/client-ecs'
import {
  createReplicaSetBackup,
  finalizeRestoredBackup,
  openAgentStorage,
  parseBackupManifestBytes,
  readReadyObjectCustody,
  restoreBackupOffline,
  captureS3ObjectCustody,
  S3VersionedObjectProbe,
  S3VersionedObjectRestoreTransport,
  AgentStorageError,
  type AgentBackupManifest,
  type BackupAdmissionQuiesceProof,
  type ArchivedCredentialProbe,
  type ObjectCustodyRecord,
  type OfflineRestoreReceipt,
  type RestorePrincipalRotation,
  type RestoreTargetIdentity,
  type IsolatedRestoreMaintenanceProof,
  type ValidationFixtureArtifactCustody,
  type Work12InjectedObjectFailure,
  seedValidationFixture,
  readValidationFixture,
} from './index.js'

type JsonObject = Record<string, unknown>
type CommandName = 'backup' | 'restore-offline' | 'restore-finalize' | 'readiness' | 'migrate' | 'validation-seed' | 'validation-read'

function fail(message: string): never { throw new AgentStorageError('invalid_storage_config', message) }
function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`)
  return value as JsonObject
}
function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must be a nonempty string`)
  return value
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') fail(`${name} must be a boolean`)
  return value
}
function exactKeys(value: JsonObject, allowed: readonly string[], name: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...allowed].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${name} fields do not match the frozen schema`)
}
function absolutePath(value: unknown, name: string): string {
  const path = string(value, name)
  if (!isAbsolute(path)) fail(`${name} must be absolute`)
  return path
}
function assertFileOwnership(stat: { readonly uid: number; readonly mode: number; isFile(): boolean }, expectedUid: number, name: string, expectedMode: number): void {
  if (!stat.isFile() || stat.uid !== expectedUid || (stat.mode & 0o777) !== expectedMode) fail(`${name} must be an owner-controlled regular 0${expectedMode.toString(8)} file`)
}
function assertOwnedFileMode(path: string, name: string, expectedMode: number): void {
  const stat = statSync(path)
  if (typeof process.geteuid !== 'function') fail('maintenance secret ownership checks require a POSIX host')
  assertFileOwnership(stat, process.geteuid(), name, expectedMode)
}
function readOwnerReadOnlyBytes(path: string, name: string): Uint8Array {
  assertOwnedFileMode(path, name, 0o400)
  return readFileSync(path)
}
function readOwnedOutputJson(path: string, name: string): JsonObject {
  assertOwnedFileMode(path, name, 0o600)
  return parseCanonicalJson(readFileSync(path), name)
}
function parseCanonicalJson(bytes: Uint8Array, name: string): JsonObject {
  const text = Buffer.from(bytes).toString('utf8')
  let value: unknown
  try { value = JSON.parse(text) } catch { fail(`${name} is invalid JSON`) }
  if (JSON.stringify(value) !== text) fail(`${name} must use canonical JSON without whitespace or duplicate fields`)
  return object(value, name)
}
function readCanonicalJson(path: string, name: string): JsonObject {
  return parseCanonicalJson(readOwnerReadOnlyBytes(path, name), name)
}
function custody(value: unknown, name: string): ObjectCustodyRecord {
  const row = object(value, name)
  exactKeys(row, ['bucket', 'objectKey', 'versionId', 'eTag', 'sha256', 'byteLength', 'kmsKeyId', 'capturedAt'], name)
  if (!Number.isSafeInteger(row.byteLength) || Number(row.byteLength) < 0) fail(`${name}.byteLength is invalid`)
  return {
    bucket: string(row.bucket, `${name}.bucket`),
    objectKey: string(row.objectKey, `${name}.objectKey`),
    versionId: string(row.versionId, `${name}.versionId`),
    eTag: string(row.eTag, `${name}.eTag`),
    sha256: string(row.sha256, `${name}.sha256`),
    byteLength: Number(row.byteLength),
    kmsKeyId: string(row.kmsKeyId, `${name}.kmsKeyId`),
    capturedAt: string(row.capturedAt, `${name}.capturedAt`),
  }
}
function sameCustody(left: ObjectCustodyRecord, right: ObjectCustodyRecord): boolean {
  return left.bucket === right.bucket && left.objectKey === right.objectKey && left.versionId === right.versionId &&
    left.eTag.replaceAll('"', '') === right.eTag.replaceAll('"', '') && left.sha256 === right.sha256 &&
    left.byteLength === right.byteLength && left.kmsKeyId === right.kmsKeyId && left.capturedAt === right.capturedAt
}
function work12InjectedObjectFailure(value: unknown, manifest: AgentBackupManifest): Work12InjectedObjectFailure {
  const row = object(value, 'work12InjectedObjectFailure')
  exactKeys(row, ['kind', 'operationId', 'custody'], 'work12InjectedObjectFailure')
  if (row.kind !== 'injected_missing_version') fail('work12InjectedObjectFailure.kind is unsupported')
  if (row.operationId !== 'valop_work12_durable_fixture') fail('work12InjectedObjectFailure.operationId is outside the frozen Work 1.2 validation fixture')
  const exactCustody = custody(row.custody, 'work12InjectedObjectFailure.custody')
  const expectedKey = `agents/validation/${row.operationId}/absent-after-backup.bin`
  if (
    exactCustody.objectKey !== expectedKey || exactCustody.byteLength !== 32 ||
    exactCustody.bucket !== manifest.sourceResourceIds.artifactBucket || exactCustody.kmsKeyId !== manifest.sourceResourceIds.kmsKeyArn
  ) fail('work12InjectedObjectFailure.custody is outside the frozen Work 1.2 validation object')
  if (manifest.objects.filter(record => sameCustody(record, exactCustody)).length !== 1) fail('work12InjectedObjectFailure.custody must identify exactly one immutable backup-manifest object')
  return { kind: 'injected_missing_version', operationId: 'valop_work12_durable_fixture', custody: exactCustody }
}
function stringRecord(value: unknown, name: string): Readonly<Record<string, string>> {
  const row = object(value, name)
  if (Object.keys(row).length === 0) fail(`${name} cannot be empty`)
  return Object.fromEntries(Object.entries(row).map(([key, child]) => [key, string(child, `${name}.${key}`)]))
}
function mongoBase(host: string, replicaSet?: string): string {
  if (!/^[A-Za-z0-9._-]+:\d{1,5}$/.test(host)) fail('mongoHost must be one host:port endpoint')
  const query = replicaSet ? `?replicaSet=${encodeURIComponent(replicaSet)}` : ''
  return `mongodb://${host}/${query}`
}
function mongoCredentialUri(base: string, username: string, password: string, database: string, authSource: string): string {
  const url = new URL(base)
  url.pathname = database ? `/${database}` : '/'
  url.searchParams.set('authSource', authSource)
  const serialized = url.toString()
  return `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${serialized.slice('mongodb://'.length)}`
}
function targetIdentity(value: unknown): RestoreTargetIdentity {
  const row = object(value, 'target')
  exactKeys(row, ['environment', 'databaseName', 'replicaSet', 'memberEndpoint', 'resourceIds'], 'target')
  return {
    environment: string(row.environment, 'target.environment'),
    databaseName: string(row.databaseName, 'target.databaseName'),
    replicaSet: string(row.replicaSet, 'target.replicaSet'),
    memberEndpoint: string(row.memberEndpoint, 'target.memberEndpoint'),
    resourceIds: stringRecord(row.resourceIds, 'target.resourceIds'),
  }
}
function maintenanceProof(value: unknown, sessionToken: string): IsolatedRestoreMaintenanceProof {
  const row = object(value, 'maintenanceProof')
  exactKeys(row, ['serviceWasStopped', 'authDisabled', 'loopbackOnly', 'ownedProcessId', 'processStartIdentity', 'dbPathIdentity', 'resourceIds'], 'maintenanceProof')
  if (!Number.isInteger(row.ownedProcessId) || Number(row.ownedProcessId) < 2) fail('maintenanceProof.ownedProcessId is invalid')
  if (!boolean(row.serviceWasStopped, 'maintenanceProof.serviceWasStopped') || !boolean(row.authDisabled, 'maintenanceProof.authDisabled') || !boolean(row.loopbackOnly, 'maintenanceProof.loopbackOnly')) fail('maintenance proof booleans must all be true')
  return {
    serviceWasStopped: true,
    authDisabled: true,
    loopbackOnly: true,
    ownedProcessId: Number(row.ownedProcessId),
    processStartIdentity: string(row.processStartIdentity, 'maintenanceProof.processStartIdentity'),
    sessionToken,
    dbPathIdentity: string(row.dbPathIdentity, 'maintenanceProof.dbPathIdentity'),
    resourceIds: stringRecord(row.resourceIds, 'maintenanceProof.resourceIds'),
  }
}
function targetSecretVersionIds(value: unknown): Readonly<Record<RestorePrincipalRotation['kind'], string>> {
  const row = object(value, 'targetSecretVersionIds')
  exactKeys(row, ['runtime', 'migration', 'backup'], 'targetSecretVersionIds')
  const version = (child: unknown, name: string): string => { const result = string(child, name); if (!/^[A-Za-z0-9._-]{1,256}$/.test(result)) fail(`${name} is invalid`); return result }
  return { runtime: version(row.runtime, 'targetSecretVersionIds.runtime'), migration: version(row.migration, 'targetSecretVersionIds.migration'), backup: version(row.backup, 'targetSecretVersionIds.backup') }
}
function sourceSecretVersionIds(value: unknown): Readonly<Record<RestorePrincipalRotation['kind'], string>> {
  const row = object(value, 'sourceSecretVersionIds')
  exactKeys(row, ['runtime', 'migration', 'backup'], 'sourceSecretVersionIds')
  const version = (child: unknown, name: string): string => { const result = string(child, name); if (!/^[A-Za-z0-9._-]{1,256}$/.test(result)) fail(`${name} is invalid`); return result }
  return { runtime: version(row.runtime, 'sourceSecretVersionIds.runtime'), migration: version(row.migration, 'sourceSecretVersionIds.migration'), backup: version(row.backup, 'sourceSecretVersionIds.backup') }
}
function ecsAdmissionProbe(value: unknown, environment: string, region: string): { readonly kind: 'ecs-describe-service'; readonly clusterArn: string; readonly serviceArn: string } {
  const row = object(value, 'admissionQuiesceProbe')
  exactKeys(row, ['kind', 'clusterArn', 'serviceArn'], 'admissionQuiesceProbe')
  if (row.kind !== 'ecs-describe-service') fail('admissionQuiesceProbe.kind is unsupported')
  const clusterArn = string(row.clusterArn, 'admissionQuiesceProbe.clusterArn')
  const serviceArn = string(row.serviceArn, 'admissionQuiesceProbe.serviceArn')
  const cluster = /^arn:([^:]+):ecs:([^:]+):([0-9]{12}):cluster\/([^/]+)$/.exec(clusterArn)
  const service = /^arn:([^:]+):ecs:([^:]+):([0-9]{12}):service\/([^/]+)\/([^/]+)$/.exec(serviceArn)
  const expectedName = `stokd-agent-api-${environment}`
  if (
    !cluster || !service || cluster[1] !== service[1] || cluster[2] !== region || service[2] !== region || cluster[3] !== service[3] ||
    cluster[4] !== expectedName || service[4] !== expectedName || service[5] !== expectedName
  ) fail('admissionQuiesceProbe must identify the exact stage ECS cluster and single API service in the configured account and region')
  return { kind: 'ecs-describe-service', clusterArn, serviceArn }
}
function principals(target: RestoreTargetIdentity, migrationRoleName: string, secrets: JsonObject, secretVersionIds: Readonly<Record<RestorePrincipalRotation['kind'], string>>): readonly RestorePrincipalRotation[] {
  return [
    {
      kind: 'runtime',
      username: 'agent_runtime',
      authDatabase: target.databaseName,
      newPassword: string(secrets.runtimePassword, 'credentials.runtimePassword'),
      secretVersionId: secretVersionIds.runtime,
      roles: [{ role: 'readWrite', db: target.databaseName }],
    },
    {
      kind: 'migration',
      username: 'agent_migration',
      authDatabase: 'admin',
      newPassword: string(secrets.migrationPassword, 'credentials.migrationPassword'),
      secretVersionId: secretVersionIds.migration,
      roles: [{ role: migrationRoleName, db: 'admin' }],
      roleDefinition: {
        role: migrationRoleName,
        privileges: [{ resource: { cluster: true }, actions: ['getParameter'] }],
        roles: [{ role: 'readWrite', db: target.databaseName }, { role: 'dbAdmin', db: target.databaseName }],
      },
    },
    {
      kind: 'backup',
      username: 'agent_backup',
      authDatabase: 'admin',
      newPassword: string(secrets.backupPassword, 'credentials.backupPassword'),
      secretVersionId: secretVersionIds.backup,
      roles: [{ role: 'backup', db: 'admin' }, { role: 'clusterMonitor', db: 'admin' }],
    },
  ] as const
}
function writeOutput(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, JSON.stringify(value))
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    const directory = openSync(dirname(path), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }
}
async function putVersionedObject(input: {
  client: S3Client
  bucket: string
  key: string
  kmsKeyArn: string
  body: Uint8Array | ReturnType<typeof createReadStream>
  byteLength: number
  sha256: string
  contentType: string
  multipartThresholdBytes?: number
  multipartPartSizeBytes?: number
}): Promise<ObjectCustodyRecord> {
  const threshold = input.multipartThresholdBytes ?? 5_000_000_000
  const configuredPartSize = input.multipartPartSizeBytes ?? 64 * 1024 * 1024
  if (!Number.isSafeInteger(threshold) || threshold < 0 || threshold > 5_000_000_000) fail('S3 upload multipart threshold is invalid')
  if (!Number.isSafeInteger(configuredPartSize) || configuredPartSize < 5 * 1024 * 1024 || configuredPartSize > 5_000_000_000) fail('S3 upload multipart part size is invalid')
  const partSize = Math.max(configuredPartSize, Math.ceil(input.byteLength / 10_000))
  if (partSize > 5_000_000_000) throw new AgentStorageError('object_custody_mismatch', 'backup archive exceeds the S3 multipart upload capacity')
  let versionId: string | undefined
  if (input.byteLength <= threshold) {
    const result = await input.client.send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: input.body,
      ContentLength: input.byteLength,
      ContentType: input.contentType,
      Metadata: { sha256: input.sha256 },
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: input.kmsKeyArn,
    }))
    versionId = result.VersionId
  } else {
    const created = await input.client.send(new CreateMultipartUploadCommand({
      Bucket: input.bucket,
      Key: input.key,
      ContentType: input.contentType,
      Metadata: { sha256: input.sha256 },
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: input.kmsKeyArn,
    }))
    const uploadId = created.UploadId
    if (!uploadId) throw new AgentStorageError('object_custody_mismatch', 'S3 multipart upload did not return an UploadId')
    const completedParts: { ETag: string; PartNumber: number }[] = []
    let buffered = Buffer.alloc(0)
    let partNumber = 1
    const upload = async (body: Buffer): Promise<void> => {
      const result = await input.client.send(new UploadPartCommand({ Bucket: input.bucket, Key: input.key, UploadId: uploadId, PartNumber: partNumber, Body: body, ContentLength: body.byteLength }))
      if (!result.ETag) throw new AgentStorageError('object_custody_mismatch', 'S3 multipart upload part did not return an ETag')
      completedParts.push({ ETag: result.ETag, PartNumber: partNumber })
      partNumber += 1
    }
    try {
      const chunks = input.body instanceof Uint8Array ? [input.body] : input.body
      for await (const raw of chunks) {
        const chunk = Buffer.from(raw)
        buffered = buffered.byteLength === 0 ? chunk : Buffer.concat([buffered, chunk])
        while (buffered.byteLength >= partSize) {
          await upload(buffered.subarray(0, partSize))
          buffered = buffered.subarray(partSize)
        }
      }
      if (buffered.byteLength > 0) await upload(buffered)
      if (completedParts.length === 0) throw new AgentStorageError('object_custody_mismatch', 'S3 multipart upload received no bytes')
      const completed = await input.client.send(new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: uploadId,
        MultipartUpload: { Parts: completedParts },
      }))
      versionId = completed.VersionId
    } catch (error) {
      await input.client.send(new AbortMultipartUploadCommand({ Bucket: input.bucket, Key: input.key, UploadId: uploadId })).catch(() => undefined)
      throw error
    }
  }
  if (!versionId) throw new AgentStorageError('object_custody_mismatch', 'S3 upload did not return a VersionId')
  return captureS3ObjectCustody({
    client: input.client,
    bucket: input.bucket,
    objectKey: input.key,
    versionId,
    expectedSha256: input.sha256,
    expectedKmsKeyId: input.kmsKeyArn,
  })
}

export const internalMaintenanceCli = { assertFileOwnership, putVersionedObject, readOwnerReadOnlyBytes, readOwnedOutputJson, writeOutput }
function s3ObjectConfig(value: unknown, name: string): { bucket: string; key: string; kmsKeyArn: string } {
  const row = object(value, name)
  exactKeys(row, ['bucket', 'key', 'kmsKeyArn'], name)
  return { bucket: string(row.bucket, `${name}.bucket`), key: string(row.key, `${name}.key`), kmsKeyArn: string(row.kmsKeyArn, `${name}.kmsKeyArn`) }
}
function validationArtifactCustody(value: unknown): ValidationFixtureArtifactCustody {
  const envelope = object(value, 'validation artifact custody')
  exactKeys(envelope, ['schemaVersion', 'retained', 'absentAfterBackup'], 'validation artifact custody')
  if (envelope.schemaVersion !== '1.0') fail('validation artifact custody schemaVersion is unsupported')
  const parse = (child: unknown, name: string): ObjectCustodyRecord => {
    const row = object(child, name)
    exactKeys(row, ['bucket', 'objectKey', 'versionId', 'eTag', 'sha256', 'byteLength', 'kmsKeyId', 'capturedAt'], name)
    if (!Number.isSafeInteger(row.byteLength) || Number(row.byteLength) < 0) fail(`${name}.byteLength is invalid`)
    const capturedAt = string(row.capturedAt, `${name}.capturedAt`)
    if (Number.isNaN(new Date(capturedAt).getTime())) fail(`${name}.capturedAt is invalid`)
    return {
      bucket: string(row.bucket, `${name}.bucket`),
      objectKey: string(row.objectKey, `${name}.objectKey`),
      versionId: string(row.versionId, `${name}.versionId`),
      eTag: string(row.eTag, `${name}.eTag`),
      sha256: string(row.sha256, `${name}.sha256`),
      byteLength: Number(row.byteLength),
      kmsKeyId: string(row.kmsKeyId, `${name}.kmsKeyId`),
      capturedAt,
    }
  }
  return {
    retained: parse(envelope.retained, 'validation artifact custody.retained'),
    absentAfterBackup: parse(envelope.absentAfterBackup, 'validation artifact custody.absentAfterBackup'),
  }
}
function outputEnvelope(command: CommandName, result: unknown): JsonObject {
  return { schemaVersion: '1.0', command, ok: true, result }
}

function offlineReceiptFromOutput(path: string): OfflineRestoreReceipt {
  const envelope = readOwnedOutputJson(path, 'offline receipt')
  exactKeys(envelope, ['schemaVersion', 'command', 'ok', 'result'], 'offline receipt envelope')
  if (envelope.schemaVersion !== '1.0' || envelope.command !== 'restore-offline' || envelope.ok !== true) fail('offline receipt envelope is not a successful restore-offline result')
  return object(envelope.result, 'offline receipt result') as unknown as OfflineRestoreReceipt
}

async function backupCommand(config: JsonObject, secrets: JsonObject): Promise<JsonObject> {
  exactKeys(config, ['schemaVersion', 'command', 'environment', 'databaseName', 'replicaSet', 'mongoHost', 'mongodumpPath', 'workDirectory', 'sourceResourceIds', 'sourceSecretVersionIds', 'sourceResourceProofPath', 'admissionQuiesceProofPath', 'admissionQuiesceProbe', 'region', 'archiveObject', 'manifestObject'], 'backup config')
  exactKeys(secrets, ['runtimePassword', 'backupPassword'], 'backup credentials')
  const environment = string(config.environment, 'environment')
  const region = string(config.region, 'region')
  const databaseName = string(config.databaseName, 'databaseName')
  const replicaSet = string(config.replicaSet, 'replicaSet')
  const base = mongoBase(string(config.mongoHost, 'mongoHost'), replicaSet)
  const runtimeUri = mongoCredentialUri(base, 'agent_runtime', string(secrets.runtimePassword, 'credentials.runtimePassword'), databaseName, databaseName)
  const backupUri = mongoCredentialUri(base, 'agent_backup', string(secrets.backupPassword, 'credentials.backupPassword'), '', 'admin')
  const sourceResourceIds = stringRecord(config.sourceResourceIds, 'sourceResourceIds')
  const declaredSourceSecretVersionIds = sourceSecretVersionIds(config.sourceSecretVersionIds)
  const proofPath = absolutePath(config.sourceResourceProofPath, 'sourceResourceProofPath')
  const admissionProofPath = absolutePath(config.admissionQuiesceProofPath, 'admissionQuiesceProofPath')
  const admissionQuiesceProof = readCanonicalJson(admissionProofPath, 'admission quiesce proof') as unknown as BackupAdmissionQuiesceProof
  const admissionProbe = ecsAdmissionProbe(config.admissionQuiesceProbe, environment, region)
  const archiveObject = s3ObjectConfig(config.archiveObject, 'archiveObject')
  const manifestObject = s3ObjectConfig(config.manifestObject, 'manifestObject')
  const workDirectory = absolutePath(config.workDirectory, 'workDirectory')
  mkdirSync(workDirectory, { recursive: true })
  const archivePath = join(workDirectory, `agent-backup-${randomUUID()}.archive.gz`)
  const storage = await openAgentStorage({ uri: runtimeUri, environment, databaseName, expectedReplicaSet: replicaSet, principal: 'runtime' })
  const client = new S3Client({ region })
  const ecs = new ECSClient({ region })
  try {
    const inspectAdmissionQuiesce = async (): Promise<Omit<BackupAdmissionQuiesceProof, 'apiDesiredCount' | 'apiRunningCount'> & { readonly apiDesiredCount: number; readonly apiRunningCount: number }> => {
      const response = await ecs.send(new DescribeServicesCommand({ cluster: admissionProbe.clusterArn, services: [admissionProbe.serviceArn] }))
      if ((response.failures?.length ?? 0) !== 0 || response.services?.length !== 1) throw new AgentStorageError('backup_failed', 'ECS admission service could not be inspected exactly')
      const service = response.services[0]!
      const desiredCount = service.desiredCount
      const runningCount = service.runningCount
      if (service.clusterArn !== admissionProbe.clusterArn || service.serviceArn !== admissionProbe.serviceArn || typeof desiredCount !== 'number' || typeof runningCount !== 'number' || !Number.isInteger(desiredCount) || !Number.isInteger(runningCount)) {
        throw new AgentStorageError('backup_failed', 'ECS admission service identity or counts differ from the frozen probe')
      }
      return { ...admissionQuiesceProof, apiDesiredCount: desiredCount, apiRunningCount: runningCount }
    }
    const objects = await readReadyObjectCustody(storage.db)
    const receipt = await createReplicaSetBackup({
      db: storage.db,
      backupUri,
      mongodumpPath: absolutePath(config.mongodumpPath, 'mongodumpPath'),
      archivePath,
      sourceEnvironment: environment,
      sourceDatabase: databaseName,
      sourceResourceIds,
      sourceSecretVersionIds: declaredSourceSecretVersionIds,
      sourceResourceIdentityProbe: { inspect: async () => stringRecord(readCanonicalJson(proofPath, 'source resource proof'), 'source resource proof') },
      admissionQuiesceProof,
      admissionQuiesceProbe: { inspect: inspectAdmissionQuiesce },
      objects,
      custodyMode: 's3_versioned',
      publishArchive: async archive => putVersionedObject({
        client,
        ...archiveObject,
        body: createReadStream(archive.path),
        byteLength: archive.byteLength,
        sha256: archive.sha256,
        contentType: 'application/gzip',
      }),
      publishManifest: async manifest => putVersionedObject({
        client,
        ...manifestObject,
        body: manifest.bytes,
        byteLength: manifest.byteLength,
        sha256: manifest.sha256,
        contentType: 'application/json',
      }),
    })
    return outputEnvelope('backup', {
      backupId: receipt.manifest.backupId,
      restorePoint: receipt.manifest.restorePoint,
      archiveCustody: receipt.manifest.archive.custody,
      manifestSha256: receipt.manifestSha256,
      manifestCustody: receipt.manifestCustody,
      sourceResourceIds: receipt.manifest.sourceResourceIds,
      sourceSecretVersionIds: receipt.manifest.sourceSecretVersionIds,
    })
  } finally {
    await storage.close()
    client.destroy()
    ecs.destroy()
    rmSync(archivePath, { force: true })
  }
}

async function restoreOfflineCommand(config: JsonObject, secrets: JsonObject, signingKey: Uint8Array): Promise<JsonObject> {
  exactKeys(config, ['schemaVersion', 'command', 'manifestPath', 'manifestCustody', 'archiveCustody', 'localArchivePath', 'mongorestorePath', 'target', 'noAuthUri', 'maintenanceProof', 'migrationRoleName', 'targetSecretVersionIds', 'requireVersionedObjectCustody'], 'restore-offline config')
  exactKeys(secrets, ['runtimePassword', 'migrationPassword', 'backupPassword', 'maintenanceSessionToken'], 'restore-offline credentials')
  const target = targetIdentity(config.target)
  const manifestPath = absolutePath(config.manifestPath, 'manifestPath')
  const localArchivePath = absolutePath(config.localArchivePath, 'localArchivePath')
  assertOwnedFileMode(localArchivePath, 'localArchivePath', 0o400)
  const receipt = await restoreBackupOffline({
    manifestBytes: readOwnerReadOnlyBytes(manifestPath, 'manifestPath'),
    manifestCustody: custody(config.manifestCustody, 'manifestCustody'),
    archiveCustody: custody(config.archiveCustody, 'archiveCustody'),
    localArchivePath,
    mongorestorePath: absolutePath(config.mongorestorePath, 'mongorestorePath'),
    target,
    principals: principals(target, string(config.migrationRoleName, 'migrationRoleName'), secrets, targetSecretVersionIds(config.targetSecretVersionIds)),
    noAuthUri: string(config.noAuthUri, 'noAuthUri'),
    maintenanceProof: maintenanceProof(config.maintenanceProof, string(secrets.maintenanceSessionToken, 'credentials.maintenanceSessionToken')),
    receiptSigningKey: signingKey,
    requireVersionedObjectCustody: boolean(config.requireVersionedObjectCustody, 'requireVersionedObjectCustody'),
  })
  return outputEnvelope('restore-offline', receipt)
}

async function restoreFinalizeCommand(config: JsonObject, secrets: JsonObject, signingKey: Uint8Array): Promise<JsonObject> {
  const baseConfigKeys = ['schemaVersion', 'command', 'manifestPath', 'manifestCustody', 'offlineReceiptPath', 'normalMongoHost', 'target', 'migrationRoleName', 'targetSecretVersionIds', 'sourceSecretVersionIds', 'region', 'targetArtifactBucket', 'targetArtifactKmsKeyArn']
  const hasWork12Injection = Object.hasOwn(config, 'work12InjectedObjectFailure')
  exactKeys(config, hasWork12Injection ? [...baseConfigKeys, 'work12InjectedObjectFailure'] : baseConfigKeys, 'restore-finalize config')
  exactKeys(secrets, ['runtimePassword', 'migrationPassword', 'backupPassword', 'sourceRuntimePassword', 'sourceMigrationPassword', 'sourceBackupPassword', 'priorRuntimePassword', 'priorMigrationPassword', 'priorBackupPassword'], 'restore-finalize credentials')
  const target = targetIdentity(config.target)
  const manifestBytes = readOwnerReadOnlyBytes(absolutePath(config.manifestPath, 'manifestPath'), 'manifestPath')
  const manifest = parseBackupManifestBytes(manifestBytes)
  const injectedObjectFailure = hasWork12Injection ? work12InjectedObjectFailure(config.work12InjectedObjectFailure, manifest) : undefined
  if (JSON.stringify(sourceSecretVersionIds(config.sourceSecretVersionIds)) !== JSON.stringify(manifest.sourceSecretVersionIds)) fail('restore-finalize source secret VersionIds do not match the backup manifest')
  const base = mongoBase(string(config.normalMongoHost, 'normalMongoHost'), target.replicaSet)
  const archivedCredentialProbes: readonly ArchivedCredentialProbe[] = [
    { origin: 'source_archive', kind: 'runtime', uri: mongoCredentialUri(base, 'agent_runtime', string(secrets.sourceRuntimePassword, 'credentials.sourceRuntimePassword'), manifest.sourceDatabase, manifest.sourceDatabase) },
    { origin: 'source_archive', kind: 'migration', uri: mongoCredentialUri(base, 'agent_migration', string(secrets.sourceMigrationPassword, 'credentials.sourceMigrationPassword'), manifest.sourceDatabase, 'admin') },
    { origin: 'source_archive', kind: 'backup', uri: mongoCredentialUri(base, 'agent_backup', string(secrets.sourceBackupPassword, 'credentials.sourceBackupPassword'), '', 'admin') },
    { origin: 'target_pre_restore', kind: 'runtime', uri: mongoCredentialUri(base, 'agent_runtime', string(secrets.priorRuntimePassword, 'credentials.priorRuntimePassword'), target.databaseName, target.databaseName) },
    { origin: 'target_pre_restore', kind: 'migration', uri: mongoCredentialUri(base, 'agent_migration', string(secrets.priorMigrationPassword, 'credentials.priorMigrationPassword'), target.databaseName, 'admin') },
    { origin: 'target_pre_restore', kind: 'backup', uri: mongoCredentialUri(base, 'agent_backup', string(secrets.priorBackupPassword, 'credentials.priorBackupPassword'), '', 'admin') },
  ]
  const s3 = new S3Client({ region: string(config.region, 'region') })
  if (config.targetArtifactBucket !== target.resourceIds.artifactBucket || config.targetArtifactKmsKeyArn !== target.resourceIds.kmsKeyArn) fail('restore-finalize S3 target does not match target resource identity')
  try {
    const result = await finalizeRestoredBackup({
      receipt: offlineReceiptFromOutput(absolutePath(config.offlineReceiptPath, 'offlineReceiptPath')),
      receiptSigningKey: signingKey,
      manifestBytes,
      manifestCustody: custody(config.manifestCustody, 'manifestCustody'),
      normalBaseUri: base,
      target,
      principals: principals(target, string(config.migrationRoleName, 'migrationRoleName'), secrets, targetSecretVersionIds(config.targetSecretVersionIds)),
      archivedCredentialProbes,
      objectTransport: new S3VersionedObjectRestoreTransport({
        client: s3,
        targetBucket: string(config.targetArtifactBucket, 'targetArtifactBucket'),
        targetKmsKeyArn: string(config.targetArtifactKmsKeyArn, 'targetArtifactKmsKeyArn'),
        ...(injectedObjectFailure ? { work12InjectedObjectFailure: injectedObjectFailure } : {}),
      }),
    })
    return outputEnvelope('restore-finalize', result)
  } finally {
    s3.destroy()
  }
}

async function readinessCommand(config: JsonObject, secrets: JsonObject): Promise<JsonObject> {
  // Two shapes. A self-hosted node is addressed by host + replica set and the
  // runtime password composes the URI. A managed provider hands over one URI
  // that already carries its own credentials and topology -- take it verbatim.
  const managed = typeof config.mongoUri === 'string' && config.mongoUri !== ''
  if (managed) exactKeys(config, ['schemaVersion', 'command', 'environment', 'databaseName', 'mongoUri'], 'managed readiness config')
  else {
    exactKeys(config, ['schemaVersion', 'command', 'environment', 'databaseName', 'replicaSet', 'mongoHost'], 'readiness config')
    exactKeys(secrets, ['runtimePassword'], 'readiness credentials')
  }
  const environment = string(config.environment, 'environment')
  const databaseName = string(config.databaseName, 'databaseName')
  const replicaSet = managed ? '' : string(config.replicaSet, 'replicaSet')
  const uri = managed
    ? string(config.mongoUri, 'mongoUri')
    : mongoCredentialUri(mongoBase(string(config.mongoHost, 'mongoHost'), replicaSet), 'agent_runtime', string(secrets.runtimePassword, 'credentials.runtimePassword'), databaseName, databaseName)
  const storage = await openAgentStorage({ uri, environment, databaseName, expectedReplicaSet: replicaSet, principal: 'runtime', managed })
  try {
    return outputEnvelope('readiness', {
      environment,
      databaseName,
      replicaSet: storage.readiness.replicaSetName,
      serverVersion: storage.readiness.serverVersion,
      featureCompatibilityVersion: storage.readiness.featureCompatibilityVersion,
      writablePrimary: storage.readiness.writablePrimary,
      transactionProbe: 'passed',
    })
  } finally {
    await storage.close()
  }
}

async function migrateCommand(config: JsonObject, secrets: JsonObject): Promise<JsonObject> {
  const managed = typeof config.mongoUri === 'string' && config.mongoUri !== ''
  if (managed) exactKeys(config, ['schemaVersion', 'command', 'environment', 'databaseName', 'mongoUri'], 'managed migrate config')
  else {
    exactKeys(config, ['schemaVersion', 'command', 'environment', 'databaseName', 'replicaSet', 'mongoHost'], 'migrate config')
    exactKeys(secrets, ['migrationPassword'], 'migrate credentials')
  }
  const environment = string(config.environment, 'environment')
  const databaseName = string(config.databaseName, 'databaseName')
  const replicaSet = managed ? '' : string(config.replicaSet, 'replicaSet')
  const uri = managed
    ? string(config.mongoUri, 'mongoUri')
    : mongoCredentialUri(mongoBase(string(config.mongoHost, 'mongoHost'), replicaSet), 'agent_migration', string(secrets.migrationPassword, 'credentials.migrationPassword'), databaseName, 'admin')
  const storage = await openAgentStorage({ uri, environment, databaseName, expectedReplicaSet: replicaSet, principal: 'migration', managed }, { migrate: true })
  try {
    return outputEnvelope('migrate', {
      environment,
      databaseName,
      replicaSet: storage.readiness.replicaSetName,
      serverVersion: storage.readiness.serverVersion,
      featureCompatibilityVersion: storage.readiness.featureCompatibilityVersion,
      schemaVersion: storage.migration?.toVersion,
      migrationStatus: 'ready',
      migrationApplied: storage.migration?.applied,
      migrationResumed: storage.migration?.resumed,
    })
  } finally {
    await storage.close()
  }
}

async function validationSeedCommand(config: JsonObject, secrets: JsonObject): Promise<JsonObject> {
  exactKeys(config, ['schemaVersion', 'command', 'environment', 'databaseName', 'replicaSet', 'mongoHost', 'operationId', 'payloadPath', 'artifactCustodyPath', 'sourceResourceIds', 'region'], 'validation-seed config')
  exactKeys(secrets, ['runtimePassword'], 'validation-seed credentials')
  const environment = string(config.environment, 'environment')
  const databaseName = string(config.databaseName, 'databaseName')
  const replicaSet = string(config.replicaSet, 'replicaSet')
  const uri = mongoCredentialUri(mongoBase(string(config.mongoHost, 'mongoHost'), replicaSet), 'agent_runtime', string(secrets.runtimePassword, 'credentials.runtimePassword'), databaseName, databaseName)
  const resourceRow = object(config.sourceResourceIds, 'sourceResourceIds')
  exactKeys(resourceRow, ['artifactBucket', 'backupBucket', 'databaseVolumeId', 'kmsKeyArn', 'mongoInstanceId'], 'sourceResourceIds')
  const sourceResourceIds = stringRecord(resourceRow, 'sourceResourceIds')
  const artifacts = validationArtifactCustody(readCanonicalJson(absolutePath(config.artifactCustodyPath, 'artifactCustodyPath'), 'validation artifact custody'))
  const storage = await openAgentStorage({ uri, environment, databaseName, expectedReplicaSet: replicaSet, principal: 'runtime' })
  const s3 = new S3Client({ region: string(config.region, 'region') })
  try {
    const probe = new S3VersionedObjectProbe(s3)
    for (const [name, artifact] of Object.entries(artifacts)) {
      const result = await probe.headVersion(artifact)
      if (!result.exists || !result.exact) throw new AgentStorageError('object_custody_mismatch', `validation ${name} artifact is not present at the exact versioned S3 custody`, { reason: result.reason })
    }
    return outputEnvelope('validation-seed', await seedValidationFixture(storage.db, string(config.operationId, 'operationId'), readOwnerReadOnlyBytes(absolutePath(config.payloadPath, 'payloadPath'), 'validation payload'), artifacts, sourceResourceIds))
  } finally {
    await storage.close()
    s3.destroy()
  }
}

async function validationReadCommand(config: JsonObject, secrets: JsonObject): Promise<JsonObject> {
  exactKeys(config, ['schemaVersion', 'command', 'environment', 'databaseName', 'replicaSet', 'mongoHost', 'operationId', 'expectedPayloadSha256'], 'validation-read config')
  exactKeys(secrets, ['runtimePassword'], 'validation-read credentials')
  const environment = string(config.environment, 'environment')
  const databaseName = string(config.databaseName, 'databaseName')
  const replicaSet = string(config.replicaSet, 'replicaSet')
  const uri = mongoCredentialUri(mongoBase(string(config.mongoHost, 'mongoHost'), replicaSet), 'agent_runtime', string(secrets.runtimePassword, 'credentials.runtimePassword'), databaseName, databaseName)
  const storage = await openAgentStorage({ uri, environment, databaseName, expectedReplicaSet: replicaSet, principal: 'runtime' })
  try {
    return outputEnvelope('validation-read', await readValidationFixture(storage.db, string(config.operationId, 'operationId'), string(config.expectedPayloadSha256, 'expectedPayloadSha256')))
  } finally {
    await storage.close()
  }
}

export async function runMaintenanceCli(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv.length !== 1 || !['backup', 'restore-offline', 'restore-finalize', 'readiness', 'migrate', 'validation-seed', 'validation-read'].includes(argv[0]!)) fail('expected exactly one maintenance command')
  const command = argv[0] as CommandName
  const configPath = absolutePath(env.AGENT_MAINTENANCE_CONFIG, 'AGENT_MAINTENANCE_CONFIG')
  const outputPath = absolutePath(env.AGENT_OUTPUT_PATH, 'AGENT_OUTPUT_PATH')
  const config = readCanonicalJson(configPath, 'maintenance config')
  // A managed provider's URI already carries its credentials, so there is no
  // separate credential file to read. Every other path still requires one.
  const managed = typeof config.mongoUri === 'string' && config.mongoUri !== ''
  const secrets = managed && env.AGENT_CREDENTIAL_FILE === undefined
    ? {}
    : readCanonicalJson(absolutePath(env.AGENT_CREDENTIAL_FILE, 'AGENT_CREDENTIAL_FILE'), 'credential file')
  if (config.schemaVersion !== '1.0' || config.command !== command) fail('maintenance config schemaVersion/command mismatch')
  let result: JsonObject
  if (command === 'backup') result = await backupCommand(config, secrets)
  else if (command === 'migrate') result = await migrateCommand(config, secrets)
  else if (command === 'validation-seed') result = await validationSeedCommand(config, secrets)
  else if (command === 'validation-read') result = await validationReadCommand(config, secrets)
  else if (command === 'readiness') result = await readinessCommand(config, secrets)
  else {
    const signingKeyPath = absolutePath(env.AGENT_RECEIPT_HMAC_KEY_FILE, 'AGENT_RECEIPT_HMAC_KEY_FILE')
    const signingKey = readOwnerReadOnlyBytes(signingKeyPath, 'receipt HMAC key')
    result = command === 'restore-offline'
      ? await restoreOfflineCommand(config, secrets, signingKey)
      : await restoreFinalizeCommand(config, secrets, signingKey)
  }
  writeOutput(outputPath, result)
  process.stdout.write(`${JSON.stringify({ schemaVersion: '1.0', command, ok: true, outputWritten: true })}\n`)
  return 0
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runMaintenanceCli()
  } catch (error) {
    const storageError = error instanceof AgentStorageError ? error : null
    const code = storageError?.code ?? 'maintenance_failed'
    const exitCode = code === 'invalid_storage_config' ? 2 : code.startsWith('unsupported_') ? 7 : 1
    // Carry the actual cause. These messages name configuration and topology,
    // never credentials -- and without one, every failure here reads identically
    // and costs a full build cycle to identify.
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${JSON.stringify({ schemaVersion: '1.0', ok: false, error: { code, message: detail } })}\n`)
    process.exitCode = exitCode
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) await main()

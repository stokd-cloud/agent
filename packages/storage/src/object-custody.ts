import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import type { Db } from 'mongodb'
import { AgentStorageError } from './errors.js'

export interface ObjectCustodyRecord {
  readonly bucket: string
  readonly objectKey: string
  readonly versionId: string
  readonly eTag: string
  readonly sha256: string
  readonly byteLength: number
  readonly kmsKeyId: string
  readonly capturedAt: string
}

export interface ObjectVersionProbe {
  headVersion(record: ObjectCustodyRecord): Promise<{ readonly exists: boolean; readonly exact: boolean; readonly reason?: string }>
}

export interface ObjectRestoreMapping {
  readonly source: ObjectCustodyRecord
  readonly target: ObjectCustodyRecord
}

export type ObjectRestoreResult =
  | { readonly status: 'copied'; readonly mapping: ObjectRestoreMapping }
  | { readonly status: 'degraded'; readonly reason: string; readonly provenance?: 'work12_injected_missing_version_after_exact_source_head' }

export interface ObjectRestoreTransport {
  restoreVersion(record: ObjectCustodyRecord, onProgress?: () => Promise<void>): Promise<ObjectRestoreResult>
}

export interface Work12InjectedObjectFailure {
  readonly kind: 'injected_missing_version'
  readonly operationId: 'valop_work12_durable_fixture'
  readonly custody: ObjectCustodyRecord
}

export class S3VersionedObjectProbe implements ObjectVersionProbe {
  readonly client: S3Client

  constructor(client: S3Client) { this.client = client }

  async headVersion(record: ObjectCustodyRecord): Promise<{ readonly exists: boolean; readonly exact: boolean; readonly reason?: string }> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: record.bucket, Key: record.objectKey, VersionId: record.versionId }))
      if (head.VersionId !== record.versionId) return { exists: true, exact: false, reason: 'version_id_mismatch' }
      if ((head.ETag ?? '').replaceAll('"', '') !== record.eTag.replaceAll('"', '')) return { exists: true, exact: false, reason: 'etag_mismatch' }
      if (head.ContentLength !== record.byteLength) return { exists: true, exact: false, reason: 'byte_length_mismatch' }
      if (head.Metadata?.sha256 !== record.sha256) return { exists: true, exact: false, reason: 'sha256_metadata_mismatch' }
      if ((head.SSEKMSKeyId ?? '') !== record.kmsKeyId) return { exists: true, exact: false, reason: 'kms_key_mismatch' }
      return { exists: true, exact: true }
    } catch (error) {
      const metadata = (error as { readonly $metadata?: { readonly httpStatusCode?: number }; readonly name?: string })
      if (metadata.$metadata?.httpStatusCode === 404 || metadata.name === 'NoSuchKey' || metadata.name === 'NoSuchVersion') return { exists: false, exact: false, reason: 'missing_version' }
      throw error
    }
  }
}

function encodedCopySource(bucket: string, key: string, versionId: string): string {
  return `${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}?versionId=${encodeURIComponent(versionId)}`
}

function sourceCustodyBinding(record: ObjectCustodyRecord): string {
  return createHash('sha256').update(record.bucket).update('\0').update(record.objectKey).update('\0').update(record.versionId).digest('hex')
}

function custodyEquals(left: ObjectCustodyRecord, right: ObjectCustodyRecord): boolean {
  return left.bucket === right.bucket && left.objectKey === right.objectKey && left.versionId === right.versionId &&
    left.eTag.replaceAll('"', '') === right.eTag.replaceAll('"', '') && left.sha256 === right.sha256 &&
    left.byteLength === right.byteLength && left.kmsKeyId === right.kmsKeyId && left.capturedAt === right.capturedAt
}

const WORK12_VALIDATION_OPERATION_ID = 'valop_work12_durable_fixture'
const WORK12_ABSENT_AFTER_BACKUP_KEY = `agents/validation/${WORK12_VALIDATION_OPERATION_ID}/absent-after-backup.bin`

const S3_SINGLE_COPY_LIMIT_BYTES = 5_000_000_000
const S3_MINIMUM_MULTIPART_PART_BYTES = 5 * 1024 * 1024

export class S3VersionedObjectRestoreTransport implements ObjectRestoreTransport {
  readonly client: S3Client
  readonly targetBucket: string
  readonly targetKmsKeyArn: string
  readonly multipartThresholdBytes: number
  readonly multipartPartSizeBytes: number
  readonly work12InjectedObjectFailure: Work12InjectedObjectFailure | undefined

  constructor(input: {
    readonly client: S3Client
    readonly targetBucket: string
    readonly targetKmsKeyArn: string
    readonly multipartThresholdBytes?: number
    readonly multipartPartSizeBytes?: number
    readonly work12InjectedObjectFailure?: Work12InjectedObjectFailure
  }) {
    this.client = input.client
    this.targetBucket = input.targetBucket
    this.targetKmsKeyArn = input.targetKmsKeyArn
    this.multipartThresholdBytes = input.multipartThresholdBytes ?? S3_SINGLE_COPY_LIMIT_BYTES
    this.multipartPartSizeBytes = input.multipartPartSizeBytes ?? 512 * 1024 * 1024
    this.work12InjectedObjectFailure = input.work12InjectedObjectFailure
    if (!Number.isSafeInteger(this.multipartThresholdBytes) || this.multipartThresholdBytes < 0 || this.multipartThresholdBytes > S3_SINGLE_COPY_LIMIT_BYTES) {
      throw new AgentStorageError('object_custody_mismatch', 'multipart copy threshold must be between zero and the S3 single-copy ceiling')
    }
    if (!Number.isSafeInteger(this.multipartPartSizeBytes) || this.multipartPartSizeBytes < S3_MINIMUM_MULTIPART_PART_BYTES || this.multipartPartSizeBytes > S3_SINGLE_COPY_LIMIT_BYTES) {
      throw new AgentStorageError('object_custody_mismatch', 'multipart part size is outside the S3 copy limits')
    }
    const injected = this.work12InjectedObjectFailure
    if (injected && (
      injected.kind !== 'injected_missing_version' || injected.operationId !== WORK12_VALIDATION_OPERATION_ID ||
      injected.custody.objectKey !== WORK12_ABSENT_AFTER_BACKUP_KEY || injected.custody.byteLength !== 32 ||
      !injected.custody.bucket || !injected.custody.versionId || !injected.custody.eTag ||
      !/^[a-f0-9]{64}$/.test(injected.custody.sha256) || !injected.custody.kmsKeyId ||
      Number.isNaN(new Date(injected.custody.capturedAt).getTime())
    )) throw new AgentStorageError('invalid_storage_config', 'Work 1.2 injected object failure is outside the single frozen validation identity')
  }

  private async existingMapping(record: ObjectCustodyRecord): Promise<ObjectRestoreMapping | null> {
    const matches: ObjectRestoreMapping[] = []
    let keyMarker: string | undefined
    let versionIdMarker: string | undefined
    do {
      const page = await this.client.send(new ListObjectVersionsCommand({
        Bucket: this.targetBucket,
        Prefix: record.objectKey,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }))
      for (const version of page.Versions ?? []) {
        if (version.Key !== record.objectKey || !version.VersionId) continue
        const head = await this.client.send(new HeadObjectCommand({ Bucket: this.targetBucket, Key: record.objectKey, VersionId: version.VersionId }))
        const metadata = head.Metadata ?? {}
        const bound = metadata['source-custody-sha256'] === sourceCustodyBinding(record)
        if (!bound) continue
        if (
          metadata.sha256 !== record.sha256 || head.ContentLength !== record.byteLength || head.SSEKMSKeyId !== this.targetKmsKeyArn ||
          !head.VersionId || !(head.ETag ?? '').replaceAll('"', '')
        ) {
          throw new AgentStorageError('object_custody_mismatch', 'existing target version has the source binding but mismatched immutable custody', { sourceBucket: record.bucket, objectKey: record.objectKey, sourceVersionId: record.versionId, targetVersionId: version.VersionId })
        }
        if (!head.LastModified) throw new AgentStorageError('object_custody_mismatch', 'existing target version has no S3 LastModified custody timestamp')
        matches.push({
          source: record,
          target: {
            bucket: this.targetBucket,
            objectKey: record.objectKey,
            versionId: head.VersionId,
            eTag: (head.ETag ?? '').replaceAll('"', ''),
            sha256: record.sha256,
            byteLength: head.ContentLength,
            kmsKeyId: this.targetKmsKeyArn,
            capturedAt: head.LastModified.toISOString(),
          },
        })
      }
      if (!page.IsTruncated) break
      keyMarker = page.NextKeyMarker
      versionIdMarker = page.NextVersionIdMarker
      if (!keyMarker) throw new AgentStorageError('object_custody_mismatch', 'S3 version listing truncated without a continuation marker')
    } while (true)
    if (matches.length > 1) throw new AgentStorageError('object_custody_mismatch', 'multiple target versions claim the same immutable source custody', { sourceBucket: record.bucket, objectKey: record.objectKey, sourceVersionId: record.versionId, targetVersionIds: matches.map(value => value.target.versionId) })
    return matches[0] ?? null
  }

  private async multipartCopy(record: ObjectCustodyRecord, onProgress?: () => Promise<void>): Promise<string> {
    const partSize = Math.max(this.multipartPartSizeBytes, Math.ceil(record.byteLength / 10_000))
    if (partSize > S3_SINGLE_COPY_LIMIT_BYTES) throw new AgentStorageError('object_custody_mismatch', 'source object exceeds the S3 multipart copy capacity')
    const created = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.targetBucket,
      Key: record.objectKey,
      Metadata: { sha256: record.sha256, 'source-custody-sha256': sourceCustodyBinding(record) },
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: this.targetKmsKeyArn,
    }))
    const uploadId = created.UploadId
    if (!uploadId) throw new AgentStorageError('object_custody_mismatch', 'S3 multipart copy did not return an UploadId')
    const parts: { ETag: string; PartNumber: number }[] = []
    try {
      let partNumber = 1
      for (let start = 0; start < record.byteLength; start += partSize) {
        const end = Math.min(record.byteLength - 1, start + partSize - 1)
        const copied = await this.client.send(new UploadPartCopyCommand({
          Bucket: this.targetBucket,
          Key: record.objectKey,
          UploadId: uploadId,
          PartNumber: partNumber,
          CopySource: encodedCopySource(record.bucket, record.objectKey, record.versionId),
          CopySourceRange: `bytes=${start}-${end}`,
        }))
        const eTag = copied.CopyPartResult?.ETag
        if (!eTag) throw new AgentStorageError('object_custody_mismatch', 'S3 multipart part copy did not return an ETag')
        parts.push({ ETag: eTag, PartNumber: partNumber })
        await onProgress?.()
        partNumber += 1
      }
      const completed = await this.client.send(new CompleteMultipartUploadCommand({
        Bucket: this.targetBucket,
        Key: record.objectKey,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }))
      if (!completed.VersionId) throw new AgentStorageError('object_custody_mismatch', 'S3 multipart completion did not return a VersionId')
      return completed.VersionId
    } catch (error) {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.targetBucket, Key: record.objectKey, UploadId: uploadId })).catch(() => undefined)
      throw error
    }
  }

  async restoreVersion(record: ObjectCustodyRecord, onProgress?: () => Promise<void>): Promise<ObjectRestoreResult> {
    if (record.bucket === this.targetBucket) throw new AgentStorageError('object_custody_mismatch', 'restore target bucket must differ from source bucket')
    const source = await new S3VersionedObjectProbe(this.client).headVersion(record)
    if (this.work12InjectedObjectFailure && custodyEquals(record, this.work12InjectedObjectFailure.custody)) {
      if (!source.exists || !source.exact) throw new AgentStorageError('object_custody_mismatch', 'Work 1.2 injected missing-version source custody must exist exactly before degradation injection', { reason: source.reason })
      return { status: 'degraded', reason: 'missing_version', provenance: 'work12_injected_missing_version_after_exact_source_head' }
    }
    if (!source.exists) return { status: 'degraded', reason: source.reason ?? 'missing_source_version' }
    if (!source.exact) return { status: 'degraded', reason: source.reason ?? 'source_custody_mismatch' }
    const existing = await this.existingMapping(record)
    if (existing) return { status: 'copied', mapping: existing }
    const versionId = record.byteLength > this.multipartThresholdBytes
      ? await this.multipartCopy(record, onProgress)
      : (await this.client.send(new CopyObjectCommand({
          Bucket: this.targetBucket,
          Key: record.objectKey,
          CopySource: encodedCopySource(record.bucket, record.objectKey, record.versionId),
          MetadataDirective: 'REPLACE',
          Metadata: { sha256: record.sha256, 'source-custody-sha256': sourceCustodyBinding(record) },
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: this.targetKmsKeyArn,
        }))).VersionId
    if (!versionId) throw new AgentStorageError('object_custody_mismatch', 'target S3 copy did not return a VersionId')
    await onProgress?.()
    const target = await captureS3ObjectCustody({
      client: this.client,
      bucket: this.targetBucket,
      objectKey: record.objectKey,
      versionId,
      expectedSha256: record.sha256,
      expectedKmsKeyId: this.targetKmsKeyArn,
    })
    if (target.sha256 !== record.sha256 || target.byteLength !== record.byteLength) throw new AgentStorageError('object_custody_mismatch', 'restored S3 version bytes differ from source custody')
    return { status: 'copied', mapping: { source: record, target } }
  }
}

export async function captureS3ObjectCustody(input: {
  readonly client: S3Client
  readonly bucket: string
  readonly objectKey: string
  readonly versionId: string
  readonly expectedSha256: string
  readonly expectedKmsKeyId: string
}): Promise<ObjectCustodyRecord> {
  if (!input.versionId) throw new AgentStorageError('object_custody_mismatch', 'S3 VersionId is required')
  const head = await input.client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: input.objectKey, VersionId: input.versionId }))
  const sha256 = head.Metadata?.sha256 ?? ''
  const eTag = (head.ETag ?? '').replaceAll('"', '')
  if (head.VersionId !== input.versionId || !eTag || !Number.isSafeInteger(head.ContentLength) || sha256 !== input.expectedSha256 || head.SSEKMSKeyId !== input.expectedKmsKeyId) {
    throw new AgentStorageError('object_custody_mismatch', 'S3 object metadata does not match expected immutable version custody', {
      expectedVersionId: input.versionId,
      actualVersionId: head.VersionId,
      expectedSha256: input.expectedSha256,
      actualSha256: sha256,
      expectedKmsKeyId: input.expectedKmsKeyId,
      actualKmsKeyId: head.SSEKMSKeyId,
    })
  }
  if (!head.LastModified) throw new AgentStorageError('object_custody_mismatch', 'S3 object is missing LastModified custody timestamp')
  return {
    bucket: input.bucket,
    objectKey: input.objectKey,
    versionId: input.versionId,
    eTag,
    sha256,
    byteLength: head.ContentLength ?? 0,
    kmsKeyId: input.expectedKmsKeyId,
    capturedAt: head.LastModified.toISOString(),
  }
}

export async function readReadyObjectCustody(db: Db): Promise<readonly ObjectCustodyRecord[]> {
  const records = await db.collection('artifact_versions').find({ state: 'ready' }).sort({ objectKey: 1, s3VersionId: 1 }).toArray()
  return records.map(record => {
    const required = ['bucket', 'objectKey', 's3VersionId', 'eTag', 'sha256', 'kmsKeyId'] as const
    for (const key of required) if (typeof record[key] !== 'string' || record[key].length === 0) throw new AgentStorageError('object_custody_mismatch', `ready artifact is missing ${key}`, { versionId: record.versionId })
    if (!Number.isSafeInteger(record.byteLength) || record.byteLength < 0) throw new AgentStorageError('object_custody_mismatch', 'ready artifact has invalid byteLength', { versionId: record.versionId })
    if (!(record.custodyCapturedAt instanceof Date)) throw new AgentStorageError('object_custody_mismatch', 'ready artifact is missing custodyCapturedAt', { versionId: record.versionId })
    return {
      bucket: record.bucket as string,
      objectKey: record.objectKey as string,
      versionId: record.s3VersionId as string,
      eTag: record.eTag as string,
      sha256: record.sha256 as string,
      byteLength: record.byteLength as number,
      kmsKeyId: record.kmsKeyId as string,
      capturedAt: record.custodyCapturedAt.toISOString(),
    }
  })
}

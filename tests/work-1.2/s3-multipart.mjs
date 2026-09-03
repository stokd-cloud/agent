import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { S3VersionedObjectRestoreTransport } from '../../packages/storage/lib/index.js'
import { internalMaintenanceCli } from '../../packages/storage/lib/maintenance-cli.js'

const now = new Date('2026-09-02T00:00:00.000Z')
const source = {
  bucket: 'agent-source-artifacts',
  objectKey: 'agents/owner/large object.bin',
  versionId: 'source-version-exact-001',
  eTag: 'source-etag',
  sha256: 'a'.repeat(64),
  byteLength: 5 * 1024 * 1024 * 1024,
  kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/source',
  capturedAt: now.toISOString(),
}
const targetKms = 'arn:aws:kms:us-east-1:123456789012:key/target'
const copyCommands = []
const copyClient = {
  async send(command) {
    copyCommands.push(command)
    const name = command.constructor.name
    const input = command.input
    if (name === 'HeadObjectCommand' && input.Bucket === source.bucket) return { VersionId: source.versionId, ETag: `"${source.eTag}"`, ContentLength: source.byteLength, Metadata: { sha256: source.sha256 }, SSEKMSKeyId: source.kmsKeyId, LastModified: now }
    if (name === 'ListObjectVersionsCommand') return { Versions: [], IsTruncated: false }
    if (name === 'CreateMultipartUploadCommand') return { UploadId: 'upload-copy-001' }
    if (name === 'UploadPartCopyCommand') return { CopyPartResult: { ETag: `"part-${input.PartNumber}"` } }
    if (name === 'CompleteMultipartUploadCommand') return { VersionId: 'target-version-001' }
    if (name === 'HeadObjectCommand' && input.Bucket === 'agent-target-artifacts') return { VersionId: 'target-version-001', ETag: '"target-etag"', ContentLength: source.byteLength, Metadata: { sha256: source.sha256 }, SSEKMSKeyId: targetKms, LastModified: now }
    throw new Error(`unexpected copy command ${name}`)
  },
}
let copyProgress = 0
const transport = new S3VersionedObjectRestoreTransport({
  client: copyClient,
  targetBucket: 'agent-target-artifacts',
  targetKmsKeyArn: targetKms,
  multipartPartSizeBytes: 1024 * 1024 * 1024,
})
const copied = await transport.restoreVersion(source, async () => { copyProgress += 1 })
assert.equal(copied.status, 'copied')
assert.equal(copied.mapping.target.versionId, 'target-version-001')
assert.equal(copyCommands.some(command => command.constructor.name === 'CopyObjectCommand'), false, 'exact 5 GiB must not use atomic CopyObject')
const partCopies = copyCommands.filter(command => command.constructor.name === 'UploadPartCopyCommand')
assert.equal(partCopies.length, 5)
assert.equal(copyProgress, 6)
for (const command of partCopies) {
  assert.ok(command.input.CopySource.endsWith(`?versionId=${encodeURIComponent(source.versionId)}`))
  assert.equal(command.input.CopySource.includes(source.objectKey), false, 'copy source must URI-encode unsafe object-key bytes')
}
const createdCopy = copyCommands.find(command => command.constructor.name === 'CreateMultipartUploadCommand')
assert.deepEqual(Object.keys(createdCopy.input.Metadata).sort(), ['sha256', 'source-custody-sha256'])
assert.equal(Object.values(createdCopy.input.Metadata).includes(source.objectKey), false)
assert.equal(Object.values(createdCopy.input.Metadata).includes(source.versionId), false)

class UploadClient {
  constructor({ failSecondPart = false } = {}) {
    this.commands = []
    this.failSecondPart = failSecondPart
  }
  async send(command) {
    this.commands.push(command)
    const name = command.constructor.name
    if (name === 'CreateMultipartUploadCommand') return { UploadId: 'upload-body-001' }
    if (name === 'UploadPartCommand') {
      if (this.failSecondPart && command.input.PartNumber === 2) throw new Error('forced part failure')
      return { ETag: `"upload-part-${command.input.PartNumber}"` }
    }
    if (name === 'CompleteMultipartUploadCommand') return { VersionId: 'uploaded-version-001' }
    if (name === 'AbortMultipartUploadCommand') return {}
    if (name === 'HeadObjectCommand') return { VersionId: 'uploaded-version-001', ETag: '"uploaded-etag"', ContentLength: body.byteLength, Metadata: { sha256 }, SSEKMSKeyId: targetKms, LastModified: now }
    throw new Error(`unexpected upload command ${name}`)
  }
}

const body = Buffer.alloc(5 * 1024 * 1024 + 1, 0x5a)
const sha256 = createHash('sha256').update(body).digest('hex')
const uploadClient = new UploadClient()
const uploaded = await internalMaintenanceCli.putVersionedObject({
  client: uploadClient,
  bucket: 'agent-backup-bucket',
  key: 'daily/large.archive.gz',
  kmsKeyArn: targetKms,
  body,
  byteLength: body.byteLength,
  sha256,
  contentType: 'application/gzip',
  multipartThresholdBytes: 1,
  multipartPartSizeBytes: 5 * 1024 * 1024,
})
assert.equal(uploaded.versionId, 'uploaded-version-001')
assert.equal(uploadClient.commands.some(command => command.constructor.name === 'PutObjectCommand'), false)
assert.equal(uploadClient.commands.filter(command => command.constructor.name === 'UploadPartCommand').length, 2)
assert.equal(uploadClient.commands.some(command => command.constructor.name === 'CompleteMultipartUploadCommand'), true)

const failingUploadClient = new UploadClient({ failSecondPart: true })
await assert.rejects(internalMaintenanceCli.putVersionedObject({
  client: failingUploadClient,
  bucket: 'agent-backup-bucket',
  key: 'daily/failed.archive.gz',
  kmsKeyArn: targetKms,
  body,
  byteLength: body.byteLength,
  sha256,
  contentType: 'application/gzip',
  multipartThresholdBytes: 1,
  multipartPartSizeBytes: 5 * 1024 * 1024,
}), /forced part failure/)
assert.equal(failingUploadClient.commands.some(command => command.constructor.name === 'AbortMultipartUploadCommand'), true)

const injectedSource = {
  bucket: 'agent-source-artifacts',
  objectKey: 'agents/validation/valop_work12_durable_fixture/absent-after-backup.bin',
  versionId: 'source-version-injected-001',
  eTag: 'injected-source-etag',
  sha256: 'b'.repeat(64),
  byteLength: 32,
  kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/source',
  capturedAt: now.toISOString(),
}
const injectionCommands = []
const injectionClient = {
  async send(command) {
    injectionCommands.push(command)
    if (command.constructor.name === 'HeadObjectCommand') return {
      VersionId: injectedSource.versionId,
      ETag: `"${injectedSource.eTag}"`,
      ContentLength: injectedSource.byteLength,
      Metadata: { sha256: injectedSource.sha256 },
      SSEKMSKeyId: injectedSource.kmsKeyId,
      LastModified: now,
    }
    throw new Error(`injected missing-version path unexpectedly called ${command.constructor.name}`)
  },
}
const injection = {
  kind: 'injected_missing_version',
  operationId: 'valop_work12_durable_fixture',
  custody: injectedSource,
}
const injectionTransport = new S3VersionedObjectRestoreTransport({
  client: injectionClient,
  targetBucket: 'agent-target-artifacts',
  targetKmsKeyArn: targetKms,
  work12InjectedObjectFailure: injection,
})
assert.deepEqual(await injectionTransport.restoreVersion(injectedSource), {
  status: 'degraded',
  reason: 'missing_version',
  provenance: 'work12_injected_missing_version_after_exact_source_head',
})
assert.deepEqual(injectionCommands.map(command => command.constructor.name), ['HeadObjectCommand'], 'injection must HEAD-verify exact source custody and perform no copy')
assert.throws(() => new S3VersionedObjectRestoreTransport({
  client: injectionClient,
  targetBucket: 'agent-target-artifacts',
  targetKmsKeyArn: targetKms,
  work12InjectedObjectFailure: { ...injection, operationId: 'valop_other_fixture' },
}), error => error?.code === 'invalid_storage_config')
assert.throws(() => new S3VersionedObjectRestoreTransport({
  client: injectionClient,
  targetBucket: 'agent-target-artifacts',
  targetKmsKeyArn: targetKms,
  work12InjectedObjectFailure: { ...injection, custody: { ...injectedSource, objectKey: 'agents/other.bin' } },
}), error => error?.code === 'invalid_storage_config')

const missingInjectionClient = { async send() { const error = new Error('missing'); error.name = 'NoSuchVersion'; throw error } }
const missingInjectionTransport = new S3VersionedObjectRestoreTransport({
  client: missingInjectionClient,
  targetBucket: 'agent-target-artifacts',
  targetKmsKeyArn: targetKms,
  work12InjectedObjectFailure: injection,
})
await assert.rejects(missingInjectionTransport.restoreVersion(injectedSource), error => error?.code === 'object_custody_mismatch' && /must exist exactly/.test(error.message))

console.log(JSON.stringify({
  schemaVersion: '1.0',
  ok: true,
  exactFiveGiBUsesMultipartCopy: true,
  uploadParts: 2,
  abortOnFailure: true,
  rawSourceMetadataExcluded: true,
  injectedMissingVersionHeadVerified: true,
}, null, 2))

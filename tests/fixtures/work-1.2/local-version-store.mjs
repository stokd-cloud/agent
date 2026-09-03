import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const binding = record => createHash('sha256').update(record.bucket).update('\0').update(record.objectKey).update('\0').update(record.versionId).digest('hex')

export class LocalVersionStore {
  constructor(root) {
    this.root = root
    this.versions = new Map()
    this.copyCount = 0
    mkdirSync(root, { recursive: true })
  }

  key(bucket, objectKey, versionId) { return `${bucket}\0${objectKey}\0${versionId}` }

  putBytes({ bucket, objectKey, kmsKeyId, bytes, expectedSha256, sourceBinding }) {
    const content = Buffer.from(bytes)
    const digest = sha256(content)
    if (expectedSha256 && digest !== expectedSha256) throw new Error('local version bytes differ from expected sha256')
    const versionId = `local-${randomUUID()}`
    const path = join(this.root, createHash('sha256').update(this.key(bucket, objectKey, versionId)).digest('hex'))
    writeFileSync(path, content, { mode: 0o400 })
    const capturedAt = statSync(path).mtime.toISOString()
    const record = {
      bucket,
      objectKey,
      versionId,
      eTag: digest.slice(0, 32),
      sha256: digest,
      byteLength: content.byteLength,
      kmsKeyId,
      capturedAt,
    }
    this.versions.set(this.key(bucket, objectKey, versionId), { record, path, sourceBinding })
    return record
  }

  putFile({ bucket, objectKey, kmsKeyId, path, expectedSha256, expectedByteLength }) {
    const bytes = readFileSync(path)
    if (expectedByteLength !== undefined && bytes.byteLength !== expectedByteLength) throw new Error('local version file length differs from expected custody')
    return this.putBytes({ bucket, objectKey, kmsKeyId, bytes, expectedSha256 })
  }

  publishArchive({ bucket, objectKey, kmsKeyId }) {
    return async archive => this.putFile({ bucket, objectKey, kmsKeyId, path: archive.path, expectedSha256: archive.sha256, expectedByteLength: archive.byteLength })
  }

  publishManifest({ bucket, objectKey, kmsKeyId }) {
    return async manifest => this.putBytes({ bucket, objectKey, kmsKeyId, bytes: manifest.bytes, expectedSha256: manifest.sha256 })
  }

  deleteVersion(record) {
    const key = this.key(record.bucket, record.objectKey, record.versionId)
    const value = this.versions.get(key)
    if (value) rmSync(value.path, { force: true })
    this.versions.delete(key)
  }

  matchingTargetVersions(targetBucket, record) {
    const expectedBinding = binding(record)
    return [...this.versions.values()].filter(value => value.record.bucket === targetBucket && value.record.objectKey === record.objectKey && value.sourceBinding === expectedBinding)
  }

  restoreTransport({ targetBucket, targetKmsKeyId }) {
    return {
      restoreVersion: async (record, onProgress) => {
        const source = this.versions.get(this.key(record.bucket, record.objectKey, record.versionId))
        if (!source) return { status: 'degraded', reason: 'missing_source_version' }
        if (JSON.stringify(source.record) !== JSON.stringify(record) || sha256(readFileSync(source.path)) !== record.sha256) return { status: 'degraded', reason: 'source_custody_mismatch' }
        const existing = this.matchingTargetVersions(targetBucket, record)
        if (existing.length > 1) throw new Error('multiple local target versions claim one source custody')
        if (existing.length === 1) return { status: 'copied', mapping: { source: record, target: existing[0].record } }
        const targetVersionId = `local-${randomUUID()}`
        const targetPath = join(this.root, createHash('sha256').update(this.key(targetBucket, record.objectKey, targetVersionId)).digest('hex'))
        copyFileSync(source.path, targetPath)
        const target = {
          bucket: targetBucket,
          objectKey: record.objectKey,
          versionId: targetVersionId,
          eTag: record.sha256.slice(0, 32),
          sha256: record.sha256,
          byteLength: record.byteLength,
          kmsKeyId: targetKmsKeyId,
          capturedAt: statSync(targetPath).mtime.toISOString(),
        }
        this.versions.set(this.key(target.bucket, target.objectKey, target.versionId), { record: target, path: targetPath, sourceBinding: binding(record) })
        this.copyCount += 1
        await onProgress?.()
        return { status: 'copied', mapping: { source: record, target } }
      },
    }
  }
}

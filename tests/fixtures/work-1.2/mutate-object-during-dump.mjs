import { createRequire } from 'node:module'
import { existsSync, writeFileSync } from 'node:fs'

const storageRequire = createRequire(new URL('../../../packages/storage/package.json', import.meta.url))
const { MongoClient } = storageRequire('mongodb')
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

const { MONGO_URI, MONGO_DATABASE, ARTIFACT_VERSION_ID, REPLACEMENT_CUSTODY_JSON, DUMP_MARKER_PATH, MUTATION_ACK_PATH } = process.env
if (![MONGO_URI, MONGO_DATABASE, ARTIFACT_VERSION_ID, REPLACEMENT_CUSTODY_JSON, DUMP_MARKER_PATH, MUTATION_ACK_PATH].every(Boolean)) throw new Error('mutation worker environment is incomplete')
const deadline = Date.now() + 30_000
while (!existsSync(DUMP_MARKER_PATH)) {
  if (Date.now() >= deadline) throw new Error('mongodump wrapper marker did not appear')
  await sleep(20)
}
const custody = JSON.parse(REPLACEMENT_CUSTODY_JSON)
const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5_000 })
try {
  await client.connect()
  const result = await client.db(MONGO_DATABASE).collection('artifact_versions').updateOne(
    { versionId: ARTIFACT_VERSION_ID, state: 'ready' },
    { $set: {
      bucket: custody.bucket,
      objectKey: custody.objectKey,
      s3VersionId: custody.versionId,
      eTag: custody.eTag,
      sha256: custody.sha256,
      byteLength: custody.byteLength,
      kmsKeyId: custody.kmsKeyId,
      custodyCapturedAt: new Date(custody.capturedAt),
    } },
  )
  if (result.matchedCount !== 1) throw new Error('mutation worker did not find the exact ready artifact row')
  writeFileSync(MUTATION_ACK_PATH, 'mutated', { mode: 0o600 })
} finally {
  await client.close().catch(() => undefined)
}

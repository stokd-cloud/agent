import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const accountId = '167217327520'
const region = 'us-east-1'
const stages = new Set(['source-val12', 'restore-val12'])
const phaseNames = ['source-data', 'source-api-proof', 'restore-data', 'restore-api-proof', 'source-data-redeploy', 'source-api-redeploy', 'restore-data-redeploy', 'restore-api-redeploy']
const kinds = new Set(['evidence', 'fixture', 'physical-resources', ...phaseNames.map(value => `phase-${value}`)])

function parseJson(raw, label) {
  try { return JSON.parse(raw) }
  catch { throw new Error(`${label} returned invalid JSON`) }
}
function exactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields changed`)
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

export function evidenceParameterName(stage, kind) {
  if (!stages.has(stage) || !kinds.has(kind)) throw new Error('validation evidence identity is invalid')
  return `/stokd-agent/validation/work-1.2/${stage}/${kind}/v1`
}

export function evidenceObjectKey(stage, kind) {
  if (!stages.has(stage) || !kinds.has(kind)) throw new Error('validation evidence identity is invalid')
  return `validation/work-1.2/${stage}/${kind}/v1.json`
}

function expectedBucket(stage) { return `stokd-agent-artifacts-${stage}-${accountId}` }
function expectedKms(stage, kmsKeyArn) {
  if (!new RegExp(`^arn:aws:kms:${region}:${accountId}:key/[a-f0-9-]{36}$`).test(kmsKeyArn ?? '')) throw new Error(`validation evidence ${stage} KMS identity is invalid`)
  return kmsKeyArn
}

function assertPointer(pointer, stage, kind, kmsKeyArn) {
  exactKeys(pointer, ['schemaVersion', 'kind', 'stage', 'bucket', 'objectKey', 'versionId', 'eTag', 'sha256', 'byteLength', 'kmsKeyArn'], 'validation evidence pointer')
  if (
    pointer.schemaVersion !== '1.0' || pointer.kind !== 'versioned-s3-json' || pointer.stage !== stage ||
    pointer.bucket !== expectedBucket(stage) || pointer.objectKey !== evidenceObjectKey(stage, kind) ||
    pointer.kmsKeyArn !== expectedKms(stage, kmsKeyArn) ||
    !/^[A-Za-z0-9._=+\/-]{1,1024}$/.test(pointer.versionId ?? '') ||
    !/^[A-Fa-f0-9-]{8,128}$/.test(pointer.eTag ?? '') ||
    !/^[a-f0-9]{64}$/.test(pointer.sha256 ?? '') ||
    !Number.isSafeInteger(pointer.byteLength) || pointer.byteLength < 2
  ) throw new Error('validation evidence pointer identity is invalid')
  return pointer
}

function assertHead(head, pointer) {
  if (
    head.VersionId !== pointer.versionId || head.ContentLength !== pointer.byteLength ||
    head.ServerSideEncryption !== 'aws:kms' || head.SSEKMSKeyId !== pointer.kmsKeyArn ||
    head.Metadata?.sha256 !== pointer.sha256 || String(head.ETag ?? '').replaceAll('"', '') !== pointer.eTag
  ) throw new Error('validation evidence S3 custody readback changed')
}

function putParameter(aws, name, pointer, stage) {
  const raw = JSON.stringify(pointer)
  if (Buffer.byteLength(raw) > 3900) throw new Error('validation evidence pointer exceeds the Standard parameter limit')
  aws(['ssm', 'put-parameter', '--name', name, '--type', 'String', '--data-type', 'text', '--value', raw, '--overwrite', '--output', 'json'])
  aws(['ssm', 'add-tags-to-resource', '--resource-type', 'Parameter', '--resource-id', name, '--tags', 'Key=Project,Value=stokd-agent', `Key=Stage,Value=${stage}`, 'Key=Custody,Value=versioned-s3-evidence-pointer'])
}

export function writeVersionedEvidence({ aws, stage, kind, kmsKeyArn, value }) {
  if (typeof aws !== 'function') throw new Error('validation evidence AWS command boundary is required')
  expectedKms(stage, kmsKeyArn)
  const bucket = expectedBucket(stage)
  const objectKey = evidenceObjectKey(stage, kind)
  const bytes = Buffer.from(JSON.stringify(value))
  const digest = sha256(bytes)
  const directory = mkdtempSync(join(tmpdir(), 'stokd-agent-validation-evidence-'))
  const path = join(directory, `${randomUUID()}.json`)
  try {
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
    chmodSync(path, 0o600)
    const uploaded = parseJson(aws([
      's3api', 'put-object', '--bucket', bucket, '--key', objectKey, '--body', path,
      '--content-type', 'application/json', '--server-side-encryption', 'aws:kms', '--ssekms-key-id', kmsKeyArn,
      '--no-bucket-key-enabled',
      '--metadata', `sha256=${digest}`, '--tagging', `Project=stokd-agent&Stage=${stage}&Custody=validation-evidence`, '--output', 'json',
    ]), 'validation evidence upload')
    const pointer = assertPointer({
      schemaVersion: '1.0', kind: 'versioned-s3-json', stage, bucket, objectKey,
      versionId: uploaded.VersionId, eTag: String(uploaded.ETag ?? '').replaceAll('"', ''),
      sha256: digest, byteLength: bytes.byteLength, kmsKeyArn,
    }, stage, kind, kmsKeyArn)
    const head = parseJson(aws(['s3api', 'head-object', '--bucket', bucket, '--key', objectKey, '--version-id', pointer.versionId, '--output', 'json']), 'validation evidence HEAD')
    assertHead(head, pointer)
    putParameter(aws, evidenceParameterName(stage, kind), pointer, stage)
    return pointer
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function readVersionedEvidence({ aws, stage, kind, kmsKeyArn }) {
  if (typeof aws !== 'function') throw new Error('validation evidence AWS command boundary is required')
  const name = evidenceParameterName(stage, kind)
  const envelope = parseJson(aws(['ssm', 'get-parameter', '--name', name, '--output', 'json']), `SSM parameter ${name}`)
  if (typeof envelope?.Parameter?.Value !== 'string') throw new Error(`SSM parameter ${name} omitted its pointer`)
  const pointer = assertPointer(parseJson(envelope.Parameter.Value, `SSM parameter ${name} value`), stage, kind, kmsKeyArn)
  const head = parseJson(aws(['s3api', 'head-object', '--bucket', pointer.bucket, '--key', pointer.objectKey, '--version-id', pointer.versionId, '--output', 'json']), 'validation evidence HEAD')
  assertHead(head, pointer)
  const directory = mkdtempSync(join(tmpdir(), 'stokd-agent-validation-evidence-read-'))
  const path = join(directory, `${randomUUID()}.json`)
  try {
    const received = parseJson(aws(['s3api', 'get-object', '--bucket', pointer.bucket, '--key', pointer.objectKey, '--version-id', pointer.versionId, '--output', 'json', path]), 'validation evidence download')
    if (received.VersionId !== pointer.versionId) throw new Error('validation evidence download returned a different VersionId')
    const bytes = readFileSync(path)
    if (bytes.byteLength !== pointer.byteLength || sha256(bytes) !== pointer.sha256) throw new Error('validation evidence bytes changed after pointer publication')
    return { pointer, value: parseJson(bytes.toString('utf8'), 'validation evidence object') }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

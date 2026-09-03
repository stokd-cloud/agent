import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { evidenceObjectKey, evidenceParameterName, readVersionedEvidence, writeVersionedEvidence } from '../../scripts/infra-evidence.mjs'

const stage = 'source-val12'
const kind = 'evidence'
const kmsKeyArn = 'arn:aws:kms:us-east-1:167217327520:key/11111111-2222-3333-4444-555555555555'
const versionId = 'evidence-version-000000000000000000000001'
const eTag = 'a'.repeat(32)

function fakeAws() {
  const state = { object: undefined, parameter: undefined, parameterTags: undefined }
  const aws = args => {
    const [service, operation] = args
    const value = flag => args[args.indexOf(flag) + 1]
    if (service === 's3api' && operation === 'put-object') {
      const bytes = readFileSync(value('--body'))
      state.object = {
        bucket: value('--bucket'), key: value('--key'), bytes, versionId, eTag,
        kmsKeyArn: value('--ssekms-key-id'), sha256: value('--metadata').slice('sha256='.length),
      }
      return JSON.stringify({ VersionId: versionId, ETag: `"${eTag}"`, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: kmsKeyArn })
    }
    if (service === 's3api' && operation === 'head-object') {
      assert.equal(value('--bucket'), state.object.bucket)
      assert.equal(value('--key'), state.object.key)
      assert.equal(value('--version-id'), state.object.versionId)
      return JSON.stringify({ VersionId: state.object.versionId, ETag: `"${state.object.eTag}"`, ContentLength: state.object.bytes.byteLength, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: state.object.kmsKeyArn, Metadata: { sha256: state.object.sha256 } })
    }
    if (service === 's3api' && operation === 'get-object') {
      assert.equal(value('--version-id'), state.object.versionId)
      writeFileSync(args.at(-1), state.object.bytes)
      return JSON.stringify({ VersionId: state.object.versionId })
    }
    if (service === 'ssm' && operation === 'put-parameter') {
      state.parameter = value('--value')
      return JSON.stringify({ Version: 1 })
    }
    if (service === 'ssm' && operation === 'add-tags-to-resource') {
      state.parameterTags = args.slice(args.indexOf('--tags') + 1)
      return ''
    }
    if (service === 'ssm' && operation === 'get-parameter') return JSON.stringify({ Parameter: { Value: state.parameter } })
    throw new Error(`unexpected fake AWS call: ${args.join(' ')}`)
  }
  return { aws, state }
}

test('full evidence uses an exact versioned SSE-KMS object and SSM stores only its pointer', () => {
  const fixture = fakeAws()
  const value = { schemaVersion: '1.0', stage, fullEvidence: 'x'.repeat(12_000), nested: { result: true } }
  const pointer = writeVersionedEvidence({ aws: fixture.aws, stage, kind, kmsKeyArn, value })
  assert.equal(pointer.bucket, 'stokd-agent-artifacts-source-val12-167217327520')
  assert.equal(pointer.objectKey, evidenceObjectKey(stage, kind))
  assert.equal(pointer.versionId, versionId)
  assert.equal(pointer.kmsKeyArn, kmsKeyArn)
  assert.equal(pointer.sha256, createHash('sha256').update(fixture.state.object.bytes).digest('hex'))
  assert(Buffer.byteLength(fixture.state.parameter) < 3900, 'SSM pointer crossed the Standard limit')
  assert.equal(fixture.state.parameter.includes('fullEvidence'), false, 'SSM contains truncated/full evidence instead of a pointer')
  assert(fixture.state.parameterTags.includes('Key=Custody,Value=versioned-s3-evidence-pointer'))
  const restored = readVersionedEvidence({ aws: fixture.aws, stage, kind, kmsKeyArn })
  assert.deepEqual(restored.pointer, pointer)
  assert.deepEqual(restored.value, value)
  assert.equal(evidenceParameterName(stage, kind), '/stokd-agent/validation/work-1.2/source-val12/evidence/v1')
})

test('pointer identity and exact S3 version/KMS custody fail closed', () => {
  const fixture = fakeAws()
  writeVersionedEvidence({ aws: fixture.aws, stage, kind, kmsKeyArn, value: { schemaVersion: '1.0', ok: true } })
  const pointer = JSON.parse(fixture.state.parameter)
  fixture.state.parameter = JSON.stringify({ ...pointer, bucket: 'stokd-agent-artifacts-restore-val12-167217327520' })
  assert.throws(() => readVersionedEvidence({ aws: fixture.aws, stage, kind, kmsKeyArn }), /pointer identity/)
  fixture.state.parameter = JSON.stringify(pointer)
  fixture.state.object.kmsKeyArn = 'arn:aws:kms:us-east-1:167217327520:key/99999999-2222-3333-4444-555555555555'
  assert.throws(() => readVersionedEvidence({ aws: fixture.aws, stage, kind, kmsKeyArn }), /custody readback/)
})

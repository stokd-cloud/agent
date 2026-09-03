import assert from 'node:assert/strict'
import test from 'node:test'
import { apiPreviewReadiness } from '../../scripts/infra-api-preview-readiness.mjs'

const sourceDigest = 'a'.repeat(40)

function manifest(overrides = {}) {
  return {
    schemaVersion: '1.0', manifestVersion: 1,
    accountId: '167217327520', region: 'us-east-1', stage: 'source-val12', sourceDigest,
    vpc: { id: 'vpc-0123456789abcdef0' }, cluster: { id: 'stokd-agent-source-val12' },
    custody: { kmsKeyArn: 'arn:aws:kms:us-east-1:167217327520:key/11111111-1111-1111-1111-111111111111' },
    ...overrides,
  }
}

function response(value) {
  return JSON.stringify({ Parameter: { Name: '/stokd-agent/source-val12/infrastructure-manifest/v1', Type: 'String', Version: 1, Value: JSON.stringify(value) } })
}

test('API preview is deferred when its data manifest is absent or belongs to an older source digest', () => {
  assert.deepEqual(apiPreviewReadiness({
    stage: 'source-val12', sourceDigest,
    aws: () => { throw new Error('ParameterNotFound') },
  }), {
    schemaVersion: '1.0', stage: 'source-val12', ready: false,
    reason: 'data_manifest_absent', parameterName: '/stokd-agent/source-val12/infrastructure-manifest/v1',
  })
  assert.deepEqual(apiPreviewReadiness({
    stage: 'source-val12', sourceDigest,
    aws: () => response(manifest({ sourceDigest: 'b'.repeat(40) })),
  }), {
    schemaVersion: '1.0', stage: 'source-val12', ready: false,
    reason: 'data_manifest_source_digest_mismatch', parameterName: '/stokd-agent/source-val12/infrastructure-manifest/v1',
  })
})

test('API preview requires a scoped, current, well-formed data manifest', () => {
  assert.deepEqual(apiPreviewReadiness({ stage: 'source-val12', sourceDigest, aws: () => response(manifest()) }), {
    schemaVersion: '1.0', stage: 'source-val12', ready: true,
    reason: 'exact_data_manifest_present', parameterName: '/stokd-agent/source-val12/infrastructure-manifest/v1',
  })
  assert.throws(() => apiPreviewReadiness({
    stage: 'source-val12', sourceDigest,
    aws: () => response(manifest({ stage: 'restore-val12' })),
  }))
  assert.throws(() => apiPreviewReadiness({
    stage: 'source-val12', sourceDigest,
    aws: () => response({ ...manifest(), vpc: undefined }),
  }), /omitted VPC identity/)
  assert.throws(() => apiPreviewReadiness({
    stage: 'source-val12', sourceDigest,
    aws: () => '{not json',
  }), /invalid JSON/)
})

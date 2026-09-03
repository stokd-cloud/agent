import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertInfraMutationUnlocked,
  assertSstInitializationInactive,
  destructionAcknowledgement,
  parseInfraArguments,
  validateInfraAction,
} from '../../scripts/infra-action.mjs'
import { SST_HOME_IDENTITIES, SST_INIT_TERMINAL_KEY, sstInitTerminalKey } from '../../scripts/infra-sst-bootstrap.mjs'

const boundedIdentity = {
  account: '167217327520',
  arn: 'arn:aws:sts::167217327520:assumed-role/stokd-agent-validation-deploy/test',
  userId: 'AROATEST:test',
}
const boundedEnvironment = {
  AGENT_AWS_ACCOUNT_ID: '167217327520',
  AWS_REGION: 'us-east-1',
}

const physicalManifest = {
  schemaVersion: '1.0',
  accountId: '167217327520',
  region: 'us-east-1',
  stage: 'source-val12',
  sourceDigest: '1'.repeat(40),
  planDigest: '2'.repeat(64),
  physicalResources: [
    { type: 'kms-key', id: 'arn:aws:kms:us-east-1:167217327520:key/11111111-1111-1111-1111-111111111111' },
    { type: 's3-bucket', id: 'stokd-agent-artifacts-source-val12-167217327520' },
    { type: 's3-bucket', id: 'stokd-agent-backups-source-val12-167217327520' },
    { type: 'ebs-volume', id: 'vol-0123456789abcdef0' },
  ],
  custodyManifest: {
    artifactBucket: 'stokd-agent-artifacts-source-val12-167217327520',
    backupBucket: 'stokd-agent-backups-source-val12-167217327520',
    databaseVolumeId: 'vol-0123456789abcdef0',
    backupManifestVersionId: '3Lgexampleversion',
  },
}

test('wrapper rejects duplicate or overriding control arguments', () => {
  assert.throws(() => parseInfraArguments(['data', 'diff', '--stage', 'source-val12', '--stage', 'restore-val12']), /exactly one --stage/)
  assert.throws(() => parseInfraArguments(['data', 'diff', '--stage', 'source-val12', '--config', 'evil.ts']), /unrecognized infrastructure arguments/)
  assert.throws(() => parseInfraArguments(['data', 'remove', '--stage', 'source-val12', '--destructive-ack', 'one', '--destructive-ack', 'two']), /at most once/)
  assert.throws(() => parseInfraArguments(['data', 'deploy', '--stage', 'source-val12', '--target', 'OnlyTheWeakPolicy']), /unrecognized infrastructure arguments/)
})

test('every infrastructure action fails closed while the global SST initializer marker exists', () => {
  const bootstrap = JSON.stringify({ Parameter: { Name: '/sst/bootstrap', Type: 'String', Version: 5, Value: JSON.stringify({
    version: 5, asset: 'sst-asset-owtaxdsakxdh', assetEcrRegistryId: '167217327520',
    assetEcrUrl: '167217327520.dkr.ecr.us-east-1.amazonaws.com/sst-asset', state: 'sst-state-owtaxdsakxdh',
    appsyncHttp: '', appsyncRealtime: '',
  }) } })
  const read = listing => args => args[0] === 'ssm' ? bootstrap : JSON.stringify(listing)
  const terminalKeys = [SST_INIT_TERMINAL_KEY, ...SST_HOME_IDENTITIES.map(({ app, stage }) => sstInitTerminalKey(app, stage))]
  const completed = { KeyCount: terminalKeys.length, Contents: terminalKeys.map(Key => ({ Key })) }
  assert.doesNotThrow(() => assertSstInitializationInactive(read(completed)))
  assert.throws(() => assertSstInitializationInactive(read({ KeyCount: 1, Contents: [{ Key: 'bootstrap-init/work-1.2/active.json' }] })), /initialization marker/)
  assert.throws(() => assertSstInitializationInactive(read({ KeyCount: terminalKeys.length - 1, Contents: completed.Contents.slice(0, -1) })), /terminal receipt.*missing/)
  assert.throws(() => assertSstInitializationInactive(read({ IsTruncated: true, KeyCount: 0, Contents: [] })), /truncated/)
  assert.throws(() => assertSstInitializationInactive(read({ KeyCount: 2, Contents: [] })), /invalid listing/)
  assert.throws(() => assertSstInitializationInactive(read({ KeyCount: 1, Contents: [{ Key: 'outside/active.json' }] })), /escaped its exact prefix/)
  assert.throws(() => assertSstInitializationInactive(args => {
    if (args[0] === 'ssm') return bootstrap
    throw new Error('AccessDenied')
  }), /AccessDenied/)
})

test('wrapper refuses root, wrong account, wrong region, and non-deploy roles', () => {
  const input = parseInfraArguments(['data', 'diff', '--stage', 'source-val12'])
  assert.throws(() => validateInfraAction(input, { ...boundedIdentity, arn: 'arn:aws:iam::167217327520:root' }, boundedEnvironment), /root is forbidden/)
  assert.throws(() => validateInfraAction(input, { ...boundedIdentity, account: '000000000000' }, boundedEnvironment), /not the Agent validation account/)
  assert.throws(() => validateInfraAction(input, boundedIdentity, { ...boundedEnvironment, AWS_REGION: 'us-west-2' }), /region must equal/)
  assert.throws(() => validateInfraAction(input, { ...boundedIdentity, arn: 'arn:aws:sts::167217327520:assumed-role/Administrator/test' }, boundedEnvironment), /bounded stokd-agent-validation-deploy/)
})

test('remove acknowledgement binds physical IDs, custody, source, plan, account, and stage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-infra-guard-'))
  const manifestPath = join(directory, 'physical-resources.json')
  const raw = JSON.stringify(physicalManifest)
  writeFileSync(manifestPath, raw)
  const acknowledgement = destructionAcknowledgement('source-val12', raw)
  const input = parseInfraArguments(['data', 'remove', '--stage', 'source-val12', '--destructive-ack', acknowledgement])
  validateInfraAction(input, boundedIdentity, {
    ...boundedEnvironment,
    AGENT_DESTRUCTIVE_ACK: acknowledgement,
    AGENT_PHYSICAL_RESOURCE_MANIFEST: manifestPath,
  })
  for (const mutation of [
    { sourceDigest: '4'.repeat(40) },
    { planDigest: '5'.repeat(64) },
    { custodyManifest: { ...physicalManifest.custodyManifest, databaseVolumeId: 'vol-fedcba98765432100' } },
    { physicalResources: physicalManifest.physicalResources.map((entry, index) => index === 3 ? { ...entry, id: 'vol-fedcba98765432100' } : entry) },
  ]) {
    writeFileSync(manifestPath, JSON.stringify({ ...physicalManifest, ...mutation }))
    assert.throws(() => validateInfraAction(input, boundedIdentity, {
      ...boundedEnvironment,
      AGENT_DESTRUCTIVE_ACK: acknowledgement,
      AGENT_PHYSICAL_RESOURCE_MANIFEST: manifestPath,
    }), /resource-bound acknowledgement/)
  }
})

test('static logical resource names can never authorize remove', () => {
  assert.throws(() => destructionAcknowledgement('source-val12', JSON.stringify({
    schemaVersion: '1.0', accountId: '167217327520', region: 'us-east-1', stage: 'source-val12',
    sourceDigest: '1'.repeat(40), planDigest: '2'.repeat(64),
    physicalResources: [{ type: 's3-bucket', id: 'logical-artifacts' }],
    custodyManifest: {},
  })), /actual physical resource IDs|artifact, backup, and database custody/)
})

test('deploy/remove fail closed on active, malformed, or unreadable cloud restore admission state', () => {
  const active = {
    schemaVersion: '1.0', kind: 'work-1.2-restore-admission-lock', status: 'active',
    validationRunId: 'github-123', sourceDigest: '1'.repeat(40), planDigest: '2'.repeat(64),
    phase: 'restore-api-proof', stage: 'restore-val12', operationId: `work12-${'3'.repeat(32)}`,
    inputBindingSha256: '4'.repeat(64),
    sourceResourceIds: { artifactBucket: 'source-artifacts', backupBucket: 'source-backups', databaseVolumeId: 'vol-source', kmsKeyArn: 'kms-source', mongoInstanceId: 'i-source' },
    targetResourceIds: { artifactBucket: 'restore-artifacts', backupBucket: 'restore-backups', databaseVolumeId: 'vol-restore', kmsKeyArn: 'kms-restore', mongoInstanceId: 'i-restore' },
    createdAt: '2026-09-02T00:00:00.000Z',
  }
  const lockedAws = () => JSON.stringify({ Parameter: { Value: JSON.stringify(active) } })
  for (const action of ['deploy', 'remove']) assert.throws(() => assertInfraMutationUnlocked({ action }, lockedAws), /restore admission lock .* is active/)
  assert.doesNotThrow(() => assertInfraMutationUnlocked({ action: 'diff' }, () => { throw new Error('diff must not read mutation lock') }))
  assert.doesNotThrow(() => assertInfraMutationUnlocked({ action: 'deploy' }, () => { throw new Error('ParameterNotFound') }))
  assert.throws(() => assertInfraMutationUnlocked({ action: 'deploy' }, () => JSON.stringify({ Parameter: { Value: '{' } })), /invalid JSON/)
  assert.throws(() => assertInfraMutationUnlocked({ action: 'deploy' }, () => { throw new Error('AccessDenied') }), /AccessDenied/)
})

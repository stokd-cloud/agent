import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export const SST_BOOTSTRAP_PARAMETER = '/sst/bootstrap'
export const SST_BOOTSTRAP_VERSION = 5
export const SST_PASSPHRASE_DESCRIPTION = 'Stokd Agent Work 1.2 empty SST home passphrase'
export const SST_INIT_PREFIX = 'bootstrap-init/work-1.2/'
export const SST_INIT_ACTIVE_KEY = `${SST_INIT_PREFIX}active.json`
export const SST_INIT_TERMINAL_KEY = `${SST_INIT_PREFIX}terminal.json`
export const SST_HOME_IDENTITIES = [
  { app: 'stokd-agent-data', stage: 'source-val12' },
  { app: 'stokd-agent-api', stage: 'source-val12' },
  { app: 'stokd-agent-data', stage: 'restore-val12' },
  { app: 'stokd-agent-api', stage: 'restore-val12' },
]
export const SST_PASSPHRASE_IDENTITIES = [
  ...SST_HOME_IDENTITIES,
  { app: 'stokd-agent-data', stage: '_fallback' },
  { app: 'stokd-agent-api', stage: '_fallback' },
]

function exactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields changed`)
}

function json(raw, label) {
  try { return JSON.parse(raw) }
  catch { throw new Error(`${label} returned invalid JSON`) }
}

export function parseSstBootstrapValue(raw) {
  assert.equal(typeof raw, 'string', 'SST bootstrap value must be a string')
  const value = json(raw, 'SST bootstrap value')
  exactKeys(value, ['version', 'asset', 'assetEcrRegistryId', 'assetEcrUrl', 'state', 'appsyncHttp', 'appsyncRealtime'], 'SST bootstrap value')
  assert.equal(value.version, SST_BOOTSTRAP_VERSION, `SST bootstrap version must equal ${SST_BOOTSTRAP_VERSION}`)
  assert.match(value.asset, /^sst-asset-[a-z0-9]{12}$/, 'SST bootstrap asset bucket is invalid')
  assert.match(value.state, /^sst-state-[a-z0-9]{12}$/, 'SST bootstrap state bucket is invalid')
  assert.notEqual(value.asset, value.state, 'SST bootstrap asset and state buckets must differ')
  assert.equal(value.assetEcrRegistryId, '167217327520', 'SST bootstrap asset ECR registry changed')
  assert.equal(value.assetEcrUrl, '167217327520.dkr.ecr.us-east-1.amazonaws.com/sst-asset', 'SST bootstrap asset ECR URL changed')
  assert.equal(value.appsyncHttp, '', 'SST bootstrap unexpectedly enables AppSync HTTP')
  assert.equal(value.appsyncRealtime, '', 'SST bootstrap unexpectedly enables AppSync realtime')
  return {
    ...value,
    sha256: createHash('sha256').update(raw).digest('hex'),
  }
}

export function parseSstBootstrapParameter(raw) {
  const envelope = json(raw, 'SST bootstrap parameter')
  exactKeys(envelope, ['Parameter'], 'SST bootstrap parameter')
  const parameter = envelope.Parameter
  assert(parameter && typeof parameter === 'object' && !Array.isArray(parameter), 'SST bootstrap parameter omitted Parameter')
  assert.equal(parameter.Name, SST_BOOTSTRAP_PARAMETER, 'SST bootstrap parameter name changed')
  assert.equal(parameter.Type, 'String', 'SST bootstrap parameter must be a non-secret String')
  assert(Number.isSafeInteger(parameter.Version) && parameter.Version > 0, 'SST bootstrap parameter version is invalid')
  return { ...parseSstBootstrapValue(parameter.Value), parameterVersion: parameter.Version }
}

export function assertUsEast1BucketLocation(raw, bucket) {
  const value = json(raw, `${bucket} location`)
  exactKeys(value, ['LocationConstraint'], `${bucket} location`)
  assert.equal(value.LocationConstraint, null, `${bucket} must remain in us-east-1`)
}

export function assertSstAssetEcr(raw, bootstrap) {
  const envelope = json(raw, 'SST bootstrap asset ECR')
  exactKeys(envelope, ['repositories'], 'SST bootstrap asset ECR')
  assert.equal(envelope.repositories.length, 1, 'SST bootstrap asset ECR must resolve exactly once')
  const repository = envelope.repositories[0]
  assert.equal(repository.registryId, bootstrap.assetEcrRegistryId)
  assert.equal(repository.repositoryName, 'sst-asset')
  assert.equal(repository.repositoryUri, bootstrap.assetEcrUrl)
  assert.equal(repository.repositoryArn, 'arn:aws:ecr:us-east-1:167217327520:repository/sst-asset')
  return repository
}

export function assertSstStateBucketControls({ versioningRaw, encryptionRaw, publicAccessRaw }) {
  const versioning = json(versioningRaw, 'SST state bucket versioning')
  assert.equal(versioning.Status, 'Enabled', 'SST state bucket versioning is not enabled')
  assert.equal(versioning.MFADelete, undefined, 'SST state bucket unexpectedly reports MFA delete state')
  const encryption = json(encryptionRaw, 'SST state bucket encryption').ServerSideEncryptionConfiguration
  assert.equal(encryption?.Rules?.length, 1, 'SST state bucket must have one default encryption rule')
  const encryptionRule = encryption.Rules[0]
  assert.equal(encryptionRule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm, 'AES256', 'SST state bucket must retain default SSE-S3')
  assert.equal(encryptionRule.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID, undefined, 'SST state bucket unexpectedly uses a KMS key')
  assert([undefined, false].includes(encryptionRule.BucketKeyEnabled), 'SST state bucket unexpectedly enables bucket keys')
  const block = json(publicAccessRaw, 'SST state bucket public access').PublicAccessBlockConfiguration
  assert.deepEqual(block, { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true }, 'SST state bucket public access block changed')
  return { versioning: 'Enabled', encryption: 'AES256', publicAccessBlocked: true }
}

export function assertSstStateBucketOwnership(raw) {
  const envelope = json(raw, 'SST state bucket ownership controls')
  exactKeys(envelope, ['OwnershipControls'], 'SST state bucket ownership controls')
  assert.deepEqual(
    envelope.OwnershipControls?.Rules,
    [{ ObjectOwnership: 'BucketOwnerEnforced' }],
    'SST state bucket must enforce bucket-owner object custody',
  )
  return 'BucketOwnerEnforced'
}

export function assertSstStateBucketPolicy(raw, bucket) {
  const envelope = json(raw, 'SST state bucket policy')
  exactKeys(envelope, ['Policy'], 'SST state bucket policy')
  const policy = typeof envelope.Policy === 'string' ? json(envelope.Policy, 'SST state bucket policy body') : envelope.Policy
  const statements = Array.isArray(policy?.Statement) ? policy.Statement : [policy?.Statement].filter(Boolean)
  assert(statements.length > 0, 'SST state bucket policy has no statements')
  assert.equal(statements.some(statement => statement.Effect === 'Allow'), false, 'SST state bucket policy grants an identity access')
  const tlsDenials = statements.filter(statement => {
    const keys = Object.keys(statement).filter(key => key !== 'Sid').sort()
    if (statement.Sid !== undefined) assert.equal(typeof statement.Sid, 'string', 'SST state bucket policy Sid is invalid')
    return statement.Effect === 'Deny' && statement.Principal === '*' && statement.Action === 's3:*'
      && Array.isArray(statement.Resource)
      && statement.Resource.length === 2
      && [...statement.Resource].sort().join('\0') === [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`].sort().join('\0')
      && keys.join('\0') === ['Action', 'Condition', 'Effect', 'Principal', 'Resource'].join('\0')
      && JSON.stringify(statement.Condition) === JSON.stringify({ Bool: { 'aws:SecureTransport': 'false' } })
  })
  assert.equal(tlsDenials.length, 1, 'SST state bucket policy must contain exactly one TLS-only denial')
  assert.equal(statements.length, 1, 'SST state bucket policy contains an unreviewed statement')
  return { sha256: createHash('sha256').update(JSON.stringify(policy)).digest('hex'), tlsOnly: true }
}

function lifecyclePrefix(rule) {
  if (typeof rule.Prefix === 'string') return rule.Prefix
  if (typeof rule.Filter?.Prefix === 'string') return rule.Filter.Prefix
  if (typeof rule.Filter?.And?.Prefix === 'string') return rule.Filter.And.Prefix
  return ''
}

export function assertSstStateLifecycle(raw) {
  const envelope = json(raw, 'SST state bucket lifecycle')
  const rules = envelope.Rules ?? []
  assert(Array.isArray(rules), 'SST state bucket lifecycle rules are invalid')
  const protectedPrefixes = [
    SST_INIT_PREFIX,
    ...SST_HOME_IDENTITIES.flatMap(({ app, stage }) => sstHomeVersionPrefixes(app, stage)),
  ]
  for (const rule of rules) {
    if (rule.Status !== 'Enabled') continue
    const prefix = lifecyclePrefix(rule)
    const overlapsProtected = protectedPrefixes.some(value => value.startsWith(prefix) || prefix.startsWith(value))
    const expires = rule.Expiration !== undefined || rule.NoncurrentVersionExpiration !== undefined
      || rule.ExpiredObjectDeleteMarker === true || rule.Transitions !== undefined
      || rule.NoncurrentVersionTransitions !== undefined
    assert(!(overlapsProtected && expires), `SST state lifecycle rule ${rule.ID ?? '<unnamed>'} can expire retained Work 1.2 state`)
  }
  return { ruleCount: rules.length, retainedWork12VersionsExpire: false }
}

export function assertAwsManagedSsmKms({ describeRaw, aliasesRaw }) {
  const metadata = json(describeRaw, 'AWS-managed SSM key').KeyMetadata
  assert(metadata && typeof metadata === 'object', 'AWS-managed SSM key metadata is missing')
  assert.match(metadata.KeyId ?? '', /^[a-f0-9-]{36}$/, 'AWS-managed SSM key ID is invalid')
  assert.equal(metadata.Arn, `arn:aws:kms:us-east-1:167217327520:key/${metadata.KeyId}`)
  assert.equal(metadata.AWSAccountId, '167217327520')
  assert.equal(metadata.KeyManager, 'AWS')
  assert.equal(metadata.KeyState, 'Enabled')
  assert.equal(metadata.Enabled, true)
  assert.equal(metadata.KeyUsage, 'ENCRYPT_DECRYPT')
  assert.equal(metadata.KeySpec, 'SYMMETRIC_DEFAULT')
  assert.equal(metadata.Origin, 'AWS_KMS')
  assert.equal(metadata.MultiRegion, false)
  const aliases = json(aliasesRaw, 'AWS-managed SSM key aliases').Aliases ?? []
  assert.equal(aliases.length, 1, 'alias/aws/ssm must resolve exactly once')
  assert.equal(aliases[0].AliasName, 'alias/aws/ssm')
  assert.equal(aliases[0].TargetKeyId, metadata.KeyId)
  return { arn: metadata.Arn, keyId: metadata.KeyId, aliasName: aliases[0].AliasName, keyManager: metadata.KeyManager, state: metadata.KeyState }
}

export function sstStateKey(app, stage) {
  assert(SST_HOME_IDENTITIES.some(value => value.app === app && value.stage === stage), 'SST home identity is outside Work 1.2')
  return `app/${app}/${stage}.json`
}

export function sstLockKey(app, stage) {
  sstStateKey(app, stage)
  return `lock/${app}/${stage}.json`
}

export function sstSecretKey(app, stage) {
  assert(SST_PASSPHRASE_IDENTITIES.some(value => value.app === app && value.stage === stage), 'SST secret identity is outside Work 1.2')
  return `secret/${app}/${stage}.json`
}

export function sstPassphraseParameter(app, stage) {
  assert(SST_PASSPHRASE_IDENTITIES.some(value => value.app === app && value.stage === stage), 'SST passphrase identity is outside Work 1.2')
  return `/sst/passphrase/${app}/${stage}`
}

export function sstHomeVersionPrefixes(app, stage) {
  sstStateKey(app, stage)
  return [
    `app/${app}/${stage}.json`,
    `lock/${app}/${stage}.json`,
    `secret/${app}/${stage}.json`,
    `secret/${app}/_fallback.json`,
    `update/${app}/${stage}/`,
    `snapshot/${app}/${stage}/`,
    `eventlog/${app}/${stage}/`,
  ]
}

export function sstInitTerminalKey(app, stage) {
  sstStateKey(app, stage)
  return `${SST_INIT_PREFIX}${app}/${stage}/terminal.json`
}

export function assertSstPassphraseMetadata(raw, app, stage) {
  const name = sstPassphraseParameter(app, stage)
  const envelope = json(raw, `${name} metadata`)
  assert.equal(envelope.Parameters?.length, 1, `${name} metadata must resolve exactly once`)
  const parameter = envelope.Parameters[0]
  assert.equal(parameter.Name, name)
  assert.equal(parameter.Type, 'SecureString')
  assert.match(parameter.ARN ?? '', new RegExp(`^arn:aws:ssm:us-east-1:167217327520:parameter${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  assert(Number.isSafeInteger(parameter.Version) && parameter.Version > 0, `${name} metadata version is invalid`)
  assert.equal(parameter.KeyId, 'alias/aws/ssm', `${name} must use the existing AWS-managed SSM key`)
  assert.equal(parameter.Tier, 'Standard', `${name} must remain a Standard parameter`)
  assert.equal(parameter.DataType, 'text', `${name} data type changed`)
  assert.equal(parameter.Description, SST_PASSPHRASE_DESCRIPTION, `${name} description changed`)
  assert.deepEqual(parameter.Policies ?? [], [], `${name} unexpectedly has parameter policies`)
  assert.equal(Object.hasOwn(parameter, 'Value'), false, `${name} metadata exposed its value`)
  return {
    name, arn: parameter.ARN, version: parameter.Version, type: parameter.Type,
    keyId: parameter.KeyId, tier: parameter.Tier, dataType: parameter.DataType,
    description: parameter.Description,
  }
}

export function assertSstPassphraseTags(raw, bindingSha256) {
  assert.match(bindingSha256 ?? '', /^[a-f0-9]{64}$/)
  const envelope = json(raw, 'SST passphrase tags')
  const actual = Object.fromEntries((envelope.TagList ?? []).map(tag => [tag.Key, tag.Value]))
  assert.deepEqual(actual, { Project: 'stokd-agent', Custody: 'work-1.2-empty-sst-home', BindingSha256: bindingSha256 }, 'SST passphrase tags changed')
  return actual
}

export function parseSstStateHistory(raw, prefix) {
  const history = json(raw, `${prefix} version history`)
  const records = []
  for (const [kind, entries] of [['version', history.Versions ?? []], ['delete-marker', history.DeleteMarkers ?? []]]) {
    assert(Array.isArray(entries), `${prefix} ${kind} history is invalid`)
    for (const entry of entries) {
      assert.equal(typeof entry.Key, 'string', `${prefix} ${kind} omitted its key`)
      assert(entry.Key.startsWith(prefix), `${prefix} ${kind} escaped its exact namespace`)
      assert.match(entry.VersionId ?? '', /^[A-Za-z0-9._=+/-]{1,1024}$/, `${entry.Key} ${kind} omitted its VersionId`)
      assert.equal(typeof entry.IsLatest, 'boolean', `${entry.Key} ${kind} omitted IsLatest`)
      const lastModified = new Date(entry.LastModified)
      assert(Number.isFinite(lastModified.valueOf()), `${entry.Key} ${kind} has invalid LastModified`)
      const record = { kind, key: entry.Key, versionId: entry.VersionId, isLatest: entry.IsLatest, lastModified: lastModified.toISOString() }
      if (kind === 'version') {
        assert.match(entry.ETag ?? '', /^"[a-f0-9]{32}(?:-[1-9][0-9]*)?"$/i, `${entry.Key} version has invalid ETag`)
        assert(Number.isSafeInteger(entry.Size) && entry.Size >= 0, `${entry.Key} version has invalid size`)
        Object.assign(record, { eTag: entry.ETag, byteLength: entry.Size })
      }
      records.push(record)
    }
  }
  return records.sort((left, right) => `${left.key}\0${left.kind}\0${left.versionId}`.localeCompare(`${right.key}\0${right.kind}\0${right.versionId}`))
}

export function assertUnusedSstStateHistory(raw, prefix) {
  const records = parseSstStateHistory(raw, prefix)
  assert.equal(records.filter(value => value.kind === 'version').length, 0, `${prefix} already has retained state versions`)
  assert.equal(records.filter(value => value.kind === 'delete-marker').length, 0, `${prefix} already has retained state delete markers`)
}

function resourceType(resource) {
  assert.equal(typeof resource?.urn, 'string', 'SST state resource omitted its URN')
  const parts = resource.urn.split('::')
  assert(parts.length >= 4, 'SST state resource URN is invalid')
  return parts.at(-2)
}

export function assertSstStateCheckpoint(raw, { app, stage, requireEmpty = false }) {
  sstStateKey(app, stage)
  const versioned = json(raw, `${app}/${stage} SST state`)
  assert.equal(versioned.version, 3, `${app}/${stage} SST checkpoint version changed`)
  const checkpoint = typeof versioned.checkpoint === 'string'
    ? json(versioned.checkpoint, `${app}/${stage} SST checkpoint body`)
    : versioned.checkpoint
  assert(checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint), `${app}/${stage} SST checkpoint body is invalid`)
  assert.equal(checkpoint.stack, `organization/${app}/${stage}`, `${app}/${stage} SST checkpoint stack identity changed`)
  const resources = checkpoint.latest?.resources ?? []
  assert(Array.isArray(resources), `${app}/${stage} SST checkpoint resources are invalid`)
  const manifest = checkpoint.latest?.manifest
  assert.equal(manifest?.version, 'v3.210.0', `${app}/${stage} Pulumi version changed`)
  assert.match(manifest?.magic ?? '', /^[a-f0-9]{64}$/, `${app}/${stage} Pulumi manifest magic is invalid`)
  assert.equal(new Date(manifest?.time).toISOString(), manifest.time, `${app}/${stage} Pulumi manifest time is invalid`)
  assert(Array.isArray(manifest.plugins ?? []), `${app}/${stage} Pulumi manifest plugins are invalid`)
  const secretsProvider = checkpoint.latest?.secrets_providers
  assert.equal(secretsProvider?.type, 'passphrase', `${app}/${stage} secrets provider changed`)
  assert.deepEqual(Object.keys(secretsProvider?.state ?? {}), ['salt'], `${app}/${stage} secrets provider fields changed`)
  assert.match(secretsProvider.state.salt ?? '', /^v1:[A-Za-z0-9+/=]+:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/, `${app}/${stage} passphrase salt is invalid`)
  assert.deepEqual(checkpoint.latest?.pending_operations ?? [], [], `${app}/${stage} has pending operations`)
  assert(resources.some(resource => resourceType(resource) === 'pulumi:pulumi:Stack'), `${app}/${stage} omitted its Pulumi stack`)
  for (const resource of resources) assert.equal(resource.type, resourceType(resource), `${app}/${stage} resource type disagrees with its URN`)
  if (requireEmpty) {
    assert.deepEqual(manifest.plugins ?? [], [], `${app}/${stage} empty-state contains a provider plugin`)
    assert.equal(resources.length, 1, `${app}/${stage} empty-state resource count changed`)
    const stack = resources[0]
    assert.equal(resourceType(stack), 'pulumi:pulumi:Stack', `${app}/${stage} empty-state created a non-stack resource`)
    assert.equal(stack.type, 'pulumi:pulumi:Stack', `${app}/${stage} empty-state resource type disagrees with its URN`)
    assert.equal(
      stack.urn,
      `urn:pulumi:${stage}::${app}::pulumi:pulumi:Stack::${app}-${stage}`,
      `${app}/${stage} empty-state stack URN changed`,
    )
    assert.equal(stack.custom, false)
    assert.equal(stack.id, undefined)
    assert.deepEqual(stack.outputs, { _protect: true }, `${app}/${stage} empty-state stack outputs changed`)
  }
  return { checkpoint, resourceTypes: resources.map(resourceType).sort() }
}

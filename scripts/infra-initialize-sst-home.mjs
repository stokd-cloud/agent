import assert from 'node:assert/strict'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as systemRandomBytes,
} from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SST_BOOTSTRAP_PARAMETER,
  SST_HOME_IDENTITIES,
  SST_INIT_ACTIVE_KEY,
  SST_INIT_PREFIX,
  SST_INIT_TERMINAL_KEY,
  SST_PASSPHRASE_DESCRIPTION,
  SST_PASSPHRASE_IDENTITIES,
  assertSstPassphraseMetadata,
  assertSstPassphraseTags,
  assertSstStateCheckpoint,
  parseSstStateHistory,
  sstInitTerminalKey,
  sstLockKey,
  sstPassphraseParameter,
  sstSecretKey,
  sstStateKey,
} from './infra-sst-bootstrap.mjs'

const accountId = '167217327520'
const region = 'us-east-1'
const schemaVersion = '1.0'
const failurePrefix = `${SST_INIT_PREFIX}failures/`
const emptyDocument = Buffer.from('{}')
const emptyDocumentSha256 = createHash('sha256').update(emptyDocument).digest('hex')

function exactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields changed`)
}

function json(raw, label) {
  try { return JSON.parse(raw) }
  catch { throw new Error(`${label} returned invalid JSON`) }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function iso(value, label) {
  const result = value instanceof Date ? value.toISOString() : value
  assert.equal(new Date(result).toISOString(), result, `${label} is invalid`)
  return result
}

function versionId(value, label) {
  assert.match(value ?? '', /^[A-Za-z0-9._=+/-]{1,1024}$/, `${label} omitted its VersionId`)
  return value
}

function etag(value, label) {
  assert.match(value ?? '', /^\"[a-f0-9]{32}(?:-[1-9][0-9]*)?\"$/i, `${label} omitted its ETag`)
  return value
}

function makeDirectory(directoryFactory) {
  const directory = directoryFactory
    ? directoryFactory()
    : mkdtempSync(join(tmpdir(), 'stokd-agent-sst-home-'))
  chmodSync(directory, 0o700)
  return directory
}

function secureTemporaryFile(directoryFactory, name, body, callback) {
  const directory = makeDirectory(directoryFactory)
  const path = join(directory, name)
  try {
    writeFileSync(path, body, { flag: 'wx', mode: 0o600 })
    chmodSync(path, 0o600)
    return callback(path)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function objectMetadata(kind, bindingSha256) {
  return {
    'binding-sha256': bindingSha256,
    kind,
    'schema-version': schemaVersion,
  }
}

function metadataArgument(metadata) {
  return Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`).join(',')
}

function normalizedMetadata(value) {
  return Object.fromEntries(Object.entries(value ?? {}).map(([key, item]) => [key.toLowerCase(), item]))
}

function listCurrentExact(aws, bucket, key) {
  const envelope = json(aws([
    's3api', 'list-objects-v2', '--bucket', bucket, '--prefix', key, '--max-keys', '2',
    '--expected-bucket-owner', accountId, '--output', 'json',
  ]), `${key} current-object listing`)
  assert.equal(envelope.IsTruncated ?? false, false, `${key} current-object listing was truncated`)
  const contents = envelope.Contents ?? []
  assert(Array.isArray(contents), `${key} current-object listing is invalid`)
  if (envelope.KeyCount !== undefined) assert.equal(envelope.KeyCount, contents.length, `${key} current-object KeyCount changed`)
  assert(contents.every(value => value?.Key === key), `${key} current-object listing included an ambiguous key`)
  assert(contents.length <= 1, `${key} current-object listing returned duplicates`)
  return contents[0]
}

function readVersionedObject({ aws, bucket, key, version, directoryFactory, expectedMetadata, expectedContentType }) {
  const head = json(aws([
    's3api', 'head-object', '--bucket', bucket, '--key', key, '--version-id', version,
    '--expected-bucket-owner', accountId, '--output', 'json',
  ]), `${key} HEAD`)
  assert.equal(versionId(head.VersionId, `${key} HEAD`), version, `${key} HEAD returned a different version`)
  assert(Number.isSafeInteger(head.ContentLength) && head.ContentLength >= 0, `${key} HEAD returned an invalid length`)
  assert.equal(head.ServerSideEncryption, 'AES256', `${key} must use the shared bucket SSE-S3 control`)
  if (expectedContentType !== undefined) assert.equal(head.ContentType, expectedContentType, `${key} content type changed`)
  if (expectedMetadata !== undefined) assert.deepEqual(normalizedMetadata(head.Metadata), expectedMetadata, `${key} metadata changed`)
  const body = secureTemporaryFile(directoryFactory, 'object', Buffer.alloc(0), path => {
    const received = json(aws([
      's3api', 'get-object', '--bucket', bucket, '--key', key, '--version-id', version,
      '--expected-bucket-owner', accountId, '--output', 'json', path,
    ]), `${key} GET`)
    assert.equal(versionId(received.VersionId, `${key} GET`), version, `${key} GET returned a different version`)
    return readFileSync(path)
  })
  assert.equal(body.byteLength, head.ContentLength, `${key} body length disagrees with HEAD`)
  return {
    key,
    versionId: version,
    eTag: etag(head.ETag, `${key} HEAD`),
    byteLength: body.byteLength,
    sha256: sha256(body),
    contentType: head.ContentType,
    metadata: normalizedMetadata(head.Metadata),
    body,
  }
}

function readCurrentObject(options) {
  const listed = listCurrentExact(options.aws, options.bucket, options.key)
  if (!listed) return undefined
  const currentHead = json(options.aws([
    's3api', 'head-object', '--bucket', options.bucket, '--key', options.key,
    '--expected-bucket-owner', accountId, '--output', 'json',
  ]), `${options.key} current HEAD`)
  const pointer = readVersionedObject({ ...options, version: versionId(currentHead.VersionId, `${options.key} current HEAD`) })
  if (listed.Size !== undefined) assert.equal(listed.Size, pointer.byteLength, `${options.key} listing length changed`)
  if (listed.ETag !== undefined) assert.equal(listed.ETag, pointer.eTag, `${options.key} listing ETag changed`)
  return pointer
}

function putBodyCreateOnly({ aws, bucket, key, body, kind, bindingSha256, contentType, directoryFactory }) {
  const metadata = objectMetadata(kind, bindingSha256)
  const result = secureTemporaryFile(directoryFactory, 'body', body, path => json(aws([
    's3api', 'put-object', '--bucket', bucket, '--key', key, '--body', path,
    '--content-type', contentType, '--server-side-encryption', 'AES256',
    '--metadata', metadataArgument(metadata), '--if-none-match', '*',
    '--expected-bucket-owner', accountId, '--output', 'json',
  ]), `${key} create-only PUT`))
  const pointer = readVersionedObject({
    aws, bucket, key, version: versionId(result.VersionId, `${key} create-only PUT`),
    directoryFactory, expectedMetadata: metadata, expectedContentType: contentType,
  })
  assert.equal(pointer.sha256, sha256(body), `${key} create-only body changed`)
  return pointer
}

function putJsonCreateOnly(options, value) {
  return putBodyCreateOnly({
    ...options,
    body: Buffer.from(JSON.stringify(value)),
    contentType: 'application/json',
  })
}

function readJsonPointer(options) {
  const pointer = readVersionedObject(options)
  return { pointer: { ...pointer, body: undefined }, value: json(pointer.body.toString('utf8'), `${options.key} body`) }
}

function readCurrentJson(options) {
  const pointer = readCurrentObject(options)
  if (!pointer) return undefined
  return { pointer: { ...pointer, body: undefined }, value: json(pointer.body.toString('utf8'), `${options.key} body`) }
}

function sealActiveMarker(aws, bucket, pointer) {
  // Verification, token matching, and result construction happen before this
  // call. Conditional DELETE is deliberately the final external operation so
  // a successful seal cannot be followed by a misleading "active retained"
  // failure receipt.
  aws([
    's3api', 'delete-object', '--bucket', bucket, '--key', pointer.key,
    '--if-match', pointer.eTag, '--if-match-size', String(pointer.byteLength),
    '--expected-bucket-owner', accountId, '--output', 'json',
  ])
}

function listHistory(aws, bucket, prefix) {
  const raw = aws([
    's3api', 'list-object-versions', '--bucket', bucket, '--prefix', prefix,
    '--expected-bucket-owner', accountId, '--output', 'json',
  ])
  const envelope = json(raw, `${prefix} version history`)
  assert.equal(envelope.IsTruncated ?? false, false, `${prefix} version history was truncated`)
  return parseSstStateHistory(raw, prefix)
}

function exactKeyHistory(aws, bucket, key) {
  const history = listHistory(aws, bucket, key)
  assert(history.every(item => item.key === key), `${key} history included an ambiguous prefixed key`)
  return history
}

function assertSingleImmutableVersion(aws, bucket, key, expectedVersion, label) {
  const history = exactKeyHistory(aws, bucket, key)
  assert.equal(history.length, 1, `${label} must have exactly one retained version and no delete markers`)
  assert.equal(history[0].kind, 'version', `${label} history contains a delete marker`)
  assert.equal(history[0].versionId, expectedVersion, `${label} immutable version changed`)
  assert.equal(history[0].isLatest, true, `${label} immutable version is not current`)
  return history[0]
}

function uniquePrefixes() {
  const values = []
  for (const { app, stage } of SST_HOME_IDENTITIES) {
    values.push(
      sstStateKey(app, stage),
      sstLockKey(app, stage),
      sstSecretKey(app, stage),
      `update/${app}/${stage}/`,
      `snapshot/${app}/${stage}/`,
      `eventlog/${app}/${stage}/`,
    )
  }
  for (const app of ['stokd-agent-data', 'stokd-agent-api']) values.push(sstSecretKey(app, '_fallback'))
  return [...new Set(values)].sort()
}

function assertFreshNamespaces(aws, bucket) {
  for (const prefix of [...uniquePrefixes(), SST_INIT_PREFIX]) {
    const history = listHistory(aws, bucket, prefix)
    assert.equal(history.length, 0, `${prefix} already has retained state versions or delete markers`)
  }
}

function captureInitialInventory(aws, bucket) {
  const records = [...uniquePrefixes(), SST_INIT_PREFIX]
    .flatMap(prefix => listHistory(aws, bucket, prefix))
    .filter(record => record.key !== SST_INIT_ACTIVE_KEY && record.key !== SST_INIT_TERMINAL_KEY)
  const unique = new Map(records.map(record => [`${record.kind}\0${record.key}\0${record.versionId}`, record]))
  return [...unique.values()].sort((left, right) => `${left.key}\0${left.kind}\0${left.versionId}`.localeCompare(`${right.key}\0${right.kind}\0${right.versionId}`))
}

function assertInventoryRetained(aws, bucket, expected) {
  assert(Array.isArray(expected) && expected.length > 0, 'initial retained version inventory is empty')
  const observed = captureInitialInventory(aws, bucket)
  const identities = new Set(observed.map(value => `${value.kind}\0${value.key}\0${value.versionId}\0${value.eTag ?? ''}\0${value.byteLength ?? ''}`))
  for (const value of expected) {
    assert(identities.has(`${value.kind}\0${value.key}\0${value.versionId}\0${value.eTag ?? ''}\0${value.byteLength ?? ''}`), `${value.key} retained version ${value.versionId} disappeared`)
  }
  return observed
}

function assertReviewed(reviewed) {
  exactKeys(reviewed, [
    'reviewedSourceSha256', 'emptyConfigSha256', 'initializerSha256', 'sstVersion', 'pulumiVersion',
    'sstPackageSha256', 'sstLauncherSha256', 'sstNativePackageSha256', 'sstBinarySha256',
  ], 'reviewed SST runtime')
  for (const key of Object.keys(reviewed).filter(key => key.endsWith('Sha256'))) assert.match(reviewed[key], /^[a-f0-9]{64}$/, `${key} is invalid`)
  assert.equal(reviewed.sstVersion, '3.19.3')
  assert.equal(reviewed.pulumiVersion, '3.210.0')
  return reviewed
}

function bindingFor(bootstrap, reviewed) {
  assertReviewed(reviewed)
  const binding = {
    schemaVersion,
    kind: 'work-1.2-sst-home-initialization-binding',
    accountId,
    region,
    bootstrap: {
      parameterName: SST_BOOTSTRAP_PARAMETER,
      parameterVersion: bootstrap.parameterVersion,
      valueSha256: bootstrap.sha256,
      schemaVersion: bootstrap.version,
      stateBucket: bootstrap.state,
      assetBucket: bootstrap.asset,
      assetEcrRegistryId: bootstrap.assetEcrRegistryId,
      assetEcrUrl: bootstrap.assetEcrUrl,
    },
    homes: SST_HOME_IDENTITIES.map(({ app, stage }) => ({
      app, stage, stateKey: sstStateKey(app, stage), lockKey: sstLockKey(app, stage),
      secretKey: sstSecretKey(app, stage), passphraseParameter: sstPassphraseParameter(app, stage),
      terminalKey: sstInitTerminalKey(app, stage),
    })),
    fallbacks: ['stokd-agent-data', 'stokd-agent-api'].map(app => ({
      app, stage: '_fallback', secretKey: sstSecretKey(app, '_fallback'),
      passphraseParameter: sstPassphraseParameter(app, '_fallback'),
    })),
    reviewed,
  }
  return { binding, bindingSha256: sha256(JSON.stringify(binding)) }
}

function assertBinding(binding, bootstrap) {
  exactKeys(binding, ['schemaVersion', 'kind', 'accountId', 'region', 'bootstrap', 'homes', 'fallbacks', 'reviewed'], 'SST initialization binding')
  assert.equal(binding.schemaVersion, schemaVersion)
  assert.equal(binding.kind, 'work-1.2-sst-home-initialization-binding')
  assert.equal(binding.accountId, accountId)
  assert.equal(binding.region, region)
  assertReviewed(binding.reviewed)
  assert.deepEqual(binding.bootstrap, {
    parameterName: SST_BOOTSTRAP_PARAMETER,
    parameterVersion: bootstrap.parameterVersion,
    valueSha256: bootstrap.sha256,
    schemaVersion: bootstrap.version,
    stateBucket: bootstrap.state,
    assetBucket: bootstrap.asset,
    assetEcrRegistryId: bootstrap.assetEcrRegistryId,
    assetEcrUrl: bootstrap.assetEcrUrl,
  }, 'SST initialization bootstrap binding changed')
  assert.deepEqual(binding.homes, bindingFor(bootstrap, binding.reviewed).binding.homes, 'SST initialization home binding changed')
  assert.deepEqual(binding.fallbacks, bindingFor(bootstrap, binding.reviewed).binding.fallbacks, 'SST initialization fallback binding changed')
  return binding
}

function activeValue({ operationId, binding, bindingSha256, resumeTokenSha256, startedAt }) {
  return {
    schemaVersion, kind: 'work-1.2-sst-home-initialization-active', state: 'active',
    operationId, binding, bindingSha256, resumeTokenSha256, startedAt,
  }
}

function assertActive(value, bootstrap) {
  exactKeys(value, ['schemaVersion', 'kind', 'state', 'operationId', 'binding', 'bindingSha256', 'resumeTokenSha256', 'startedAt'], 'SST initialization active marker')
  assert.equal(value.schemaVersion, schemaVersion)
  assert.equal(value.kind, 'work-1.2-sst-home-initialization-active')
  assert.equal(value.state, 'active')
  assert.match(value.operationId, /^sstinit-[a-f0-9]{32}$/)
  assertBinding(value.binding, bootstrap)
  assert.equal(value.bindingSha256, sha256(JSON.stringify(value.binding)), 'SST initialization binding digest changed')
  assert.match(value.resumeTokenSha256, /^[a-f0-9]{64}$/)
  iso(value.startedAt, 'SST initialization start time')
  return value
}

function tryPassphraseMetadata(aws, app, stage) {
  const name = sstPassphraseParameter(app, stage)
  const raw = aws(['ssm', 'describe-parameters', '--parameter-filters', `Key=Name,Option=Equals,Values=${name}`, '--output', 'json'])
  const envelope = json(raw, `${name} metadata`)
  if ((envelope.Parameters ?? []).length === 0) return undefined
  return assertSstPassphraseMetadata(raw, app, stage)
}

function passphraseTags(aws, name, bindingSha256) {
  return assertSstPassphraseTags(aws([
    'ssm', 'list-tags-for-resource', '--resource-type', 'Parameter', '--resource-id', name, '--output', 'json',
  ]), bindingSha256)
}

function readPassphraseKey(aws, metadata) {
  const envelope = json(aws([
    'ssm', 'get-parameter', '--name', metadata.name, '--with-decryption', '--output', 'json',
  ]), `${metadata.name} decrypted read`)
  exactKeys(envelope, ['Parameter'], `${metadata.name} decrypted read`)
  assert.equal(envelope.Parameter?.Name, metadata.name)
  assert.equal(envelope.Parameter?.Type, 'SecureString')
  assert.equal(envelope.Parameter?.Version, metadata.version)
  assert.equal(typeof envelope.Parameter?.Value, 'string', `${metadata.name} decrypted value is invalid`)
  const key = Buffer.from(envelope.Parameter.Value, 'base64')
  assert.equal(key.byteLength, 32, `${metadata.name} must decode to exactly 32 bytes`)
  assert.equal(key.toString('base64'), envelope.Parameter.Value, `${metadata.name} is not canonical standard base64`)
  return key
}

function passphraseRecord(aws, app, stage, bindingSha256, metadata) {
  assert.equal(metadata.version, 1, `${metadata.name} was overwritten after create-only initialization`)
  return { app, stage, ...metadata, tags: passphraseTags(aws, metadata.name, bindingSha256) }
}

function ensurePassphrase({ aws, putSecureParameter, app, stage, bindingSha256, randomBytes }) {
  let metadata = tryPassphraseMetadata(aws, app, stage)
  if (!metadata) {
    const secret = randomBytes(32)
    assert(Buffer.isBuffer(secret) && secret.byteLength === 32, 'passphrase generator must return 32 bytes')
    const payload = {
      Name: sstPassphraseParameter(app, stage),
      Description: SST_PASSPHRASE_DESCRIPTION,
      Value: secret.toString('base64'),
      Type: 'SecureString',
      KeyId: 'alias/aws/ssm',
      Overwrite: false,
      Tags: [
        { Key: 'Project', Value: 'stokd-agent' },
        { Key: 'Custody', Value: 'work-1.2-empty-sst-home' },
        { Key: 'BindingSha256', Value: bindingSha256 },
      ],
      Tier: 'Standard',
      DataType: 'text',
    }
    try {
      const result = json(putSecureParameter(payload), `${payload.Name} create-only PUT`)
      assert.equal(result.Version, 1, `${payload.Name} create-only version changed`)
      assert.equal(result.Tier, 'Standard', `${payload.Name} create-only tier changed`)
    } finally {
      secret.fill(0)
      payload.Value = '[zeroed]'
    }
    metadata = tryPassphraseMetadata(aws, app, stage)
    assert(metadata, `${sstPassphraseParameter(app, stage)} was absent after create-only PUT`)
  }
  return passphraseRecord(aws, app, stage, bindingSha256, metadata)
}

function encryptEmptyDocument(key, randomBytes) {
  const nonce = randomBytes(12)
  assert(Buffer.isBuffer(nonce) && nonce.byteLength === 12, 'AES-GCM nonce generator must return 12 bytes')
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(emptyDocument), cipher.final()])
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()])
}

function assertEncryptedEmptyDocument(body, key, label) {
  assert(body.byteLength >= 30, `${label} encrypted body is too short`)
  const nonce = body.subarray(0, 12)
  const tag = body.subarray(body.byteLength - 16)
  const ciphertext = body.subarray(12, body.byteLength - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  assert.deepEqual(plaintext, emptyDocument, `${label} does not decrypt to the exact empty SST secret document`)
}

function secretRecord(pointer, app, stage) {
  return {
    app, stage, key: pointer.key, versionId: pointer.versionId, eTag: pointer.eTag,
    byteLength: pointer.byteLength, sha256: pointer.sha256,
    contentType: pointer.contentType, metadata: pointer.metadata,
  }
}

function ensureEncryptedSecret({ aws, bootstrap, app, stage, bindingSha256, passphrase, directoryFactory, randomBytes }) {
  const keyName = sstSecretKey(app, stage)
  const metadata = objectMetadata('sst-passphrase-empty-document', bindingSha256)
  const passphraseKey = readPassphraseKey(aws, passphrase)
  try {
    let pointer = readCurrentObject({
      aws, bucket: bootstrap.state, key: keyName, directoryFactory,
      expectedMetadata: metadata, expectedContentType: 'application/json',
    })
    if (!pointer) {
      pointer = putBodyCreateOnly({
        aws, bucket: bootstrap.state, key: keyName, body: encryptEmptyDocument(passphraseKey, randomBytes),
        kind: 'sst-passphrase-empty-document', bindingSha256, contentType: 'application/json', directoryFactory,
      })
    }
    assertEncryptedEmptyDocument(pointer.body, passphraseKey, keyName)
    const history = listHistory(aws, bootstrap.state, keyName)
    assert.equal(history.filter(value => value.kind === 'version').length, 1, `${keyName} must have exactly one retained encrypted version at initialization`)
    assert.equal(history.some(value => value.kind === 'delete-marker'), false, `${keyName} has a concealed delete marker`)
    return secretRecord(pointer, app, stage)
  } finally {
    passphraseKey.fill(0)
  }
}

function assertEmptySentinel(pointer, label) {
  assert.deepEqual(pointer.body, emptyDocument, `${label} current lock is not the exact unlocked sentinel`)
  return {
    key: pointer.key, versionId: pointer.versionId, eTag: pointer.eTag,
    byteLength: pointer.byteLength, sha256: pointer.sha256,
    contentType: pointer.contentType, metadata: pointer.metadata,
  }
}

export function ensureSstUnlockSentinel({ aws, bootstrap, app, stage, bindingSha256, directoryFactory }) {
  const key = sstLockKey(app, stage)
  const metadata = objectMetadata('sst-unlocked-sentinel', bindingSha256)
  let pointer = readCurrentObject({
    aws, bucket: bootstrap.state, key, directoryFactory,
    expectedMetadata: undefined, expectedContentType: undefined,
  })
  if (!pointer) {
    pointer = putBodyCreateOnly({
      aws, bucket: bootstrap.state, key, body: emptyDocument,
      kind: 'sst-unlocked-sentinel', bindingSha256, contentType: 'application/json', directoryFactory,
    })
  } else {
    assert.deepEqual(pointer.metadata, metadata, `${key} unlocked sentinel metadata changed`)
    assert.equal(pointer.contentType, 'application/json', `${key} unlocked sentinel content type changed`)
  }
  return assertEmptySentinel(pointer, key)
}

function stateRecord({ aws, bootstrap, app, stage, directoryFactory }) {
  const key = sstStateKey(app, stage)
  const pointer = readCurrentObject({ aws, bucket: bootstrap.state, key, directoryFactory })
  assert(pointer, `${key} is absent after the empty SST deployment`)
  assert.equal(pointer.contentType, 'application/json', `${key} state content type changed`)
  const validated = assertSstStateCheckpoint(pointer.body.toString('utf8'), { app, stage, requireEmpty: true })
  return {
    app, stage, key, versionId: pointer.versionId, eTag: pointer.eTag,
    byteLength: pointer.byteLength, sha256: pointer.sha256,
    contentType: pointer.contentType, metadata: pointer.metadata,
    resourceTypes: validated.resourceTypes,
  }
}

function pointerWithoutBody(pointer) {
  const { body: _body, ...value } = pointer
  return value
}

function assertPassphraseRecord(value, app, stage, bindingSha256) {
  exactKeys(value, ['app', 'stage', 'name', 'arn', 'version', 'type', 'keyId', 'tier', 'dataType', 'description', 'tags'], 'SST passphrase receipt')
  assert.equal(value.app, app)
  assert.equal(value.stage, stage)
  assert.equal(value.name, sstPassphraseParameter(app, stage))
  assert.equal(value.version, 1)
  assert.equal(value.type, 'SecureString')
  assert.equal(value.keyId, 'alias/aws/ssm')
  assert.equal(value.tier, 'Standard')
  assert.equal(value.dataType, 'text')
  assert.equal(value.description, SST_PASSPHRASE_DESCRIPTION)
  assert.deepEqual(value.tags, { Project: 'stokd-agent', Custody: 'work-1.2-empty-sst-home', BindingSha256: bindingSha256 })
  return value
}

function assertSecretRecord(value, app, stage, bindingSha256) {
  exactKeys(value, ['app', 'stage', 'key', 'versionId', 'eTag', 'byteLength', 'sha256', 'contentType', 'metadata'], 'SST encrypted secret receipt')
  assert.equal(value.app, app)
  assert.equal(value.stage, stage)
  assert.equal(value.key, sstSecretKey(app, stage))
  versionId(value.versionId, `${value.key} receipt`)
  etag(value.eTag, `${value.key} receipt`)
  assert.equal(value.byteLength, 30, `${value.key} encrypted empty document length changed`)
  assert.match(value.sha256, /^[a-f0-9]{64}$/)
  assert.equal(value.contentType, 'application/json')
  assert.deepEqual(value.metadata, objectMetadata('sst-passphrase-empty-document', bindingSha256))
  return value
}

function assertHomeTerminal(value, expected) {
  exactKeys(value, ['schemaVersion', 'kind', 'state', 'operationId', 'bindingSha256', 'home', 'passphrases', 'secretObjects', 'initialState', 'unlockSentinel', 'startedAt', 'completedAt'], 'SST home terminal receipt')
  assert.equal(value.schemaVersion, schemaVersion)
  assert.equal(value.kind, 'work-1.2-sst-home-terminal')
  assert.equal(value.state, 'completed')
  assert.equal(value.operationId, expected.operationId)
  assert.equal(value.bindingSha256, expected.bindingSha256)
  assert.deepEqual(value.home, { app: expected.app, stage: expected.stage })
  assert.equal(value.passphrases.length, 2)
  assertPassphraseRecord(value.passphrases[0], expected.app, expected.stage, expected.bindingSha256)
  assertPassphraseRecord(value.passphrases[1], expected.app, '_fallback', expected.bindingSha256)
  assert.equal(value.secretObjects.length, 2)
  assertSecretRecord(value.secretObjects[0], expected.app, expected.stage, expected.bindingSha256)
  assertSecretRecord(value.secretObjects[1], expected.app, '_fallback', expected.bindingSha256)
  exactKeys(value.initialState, ['app', 'stage', 'key', 'versionId', 'eTag', 'byteLength', 'sha256', 'contentType', 'metadata', 'resourceTypes'], 'SST initial state receipt')
  assert.equal(value.initialState.app, expected.app)
  assert.equal(value.initialState.stage, expected.stage)
  assert.equal(value.initialState.key, sstStateKey(expected.app, expected.stage))
  assert.deepEqual(value.initialState.resourceTypes, ['pulumi:pulumi:Stack'])
  exactKeys(value.unlockSentinel, ['key', 'versionId', 'eTag', 'byteLength', 'sha256', 'contentType', 'metadata'], 'SST unlock sentinel receipt')
  assert.equal(value.unlockSentinel.key, sstLockKey(expected.app, expected.stage))
  assert.equal(value.unlockSentinel.sha256, emptyDocumentSha256)
  assert.equal(value.unlockSentinel.contentType, 'application/json')
  iso(value.startedAt, 'SST home start time')
  iso(value.completedAt, 'SST home completion time')
  assert(new Date(value.completedAt) >= new Date(value.startedAt), 'SST home completed before it started')
  return value
}

function verifyHomeTerminal({ aws, bootstrap, value, pointer, bindingSha256, operationId, directoryFactory, passphraseMap, secretMap }) {
  const { app, stage } = value.home ?? {}
  assert(SST_HOME_IDENTITIES.some(home => home.app === app && home.stage === stage), 'SST home terminal identity changed')
  assertHomeTerminal(value, { app, stage, bindingSha256, operationId })
  assert.equal(pointer.key, sstInitTerminalKey(app, stage))
  assertSingleImmutableVersion(aws, bootstrap.state, pointer.key, pointer.versionId, `${app}/${stage} home terminal`)
  assert.deepEqual(value.passphrases, [passphraseMap.get(`${app}/${stage}`), passphraseMap.get(`${app}/_fallback`)], `${pointer.key} passphrase links changed`)
  assert.deepEqual(value.secretObjects, [secretMap.get(`${app}/${stage}`), secretMap.get(`${app}/_fallback`)], `${pointer.key} secret links changed`)
  const state = readVersionedObject({ aws, bucket: bootstrap.state, key: value.initialState.key, version: value.initialState.versionId, directoryFactory })
  assert.equal(state.sha256, value.initialState.sha256, `${state.key} initial state digest changed`)
  assert.equal(state.eTag, value.initialState.eTag, `${state.key} initial state ETag changed`)
  assert.equal(state.byteLength, value.initialState.byteLength, `${state.key} initial state length changed`)
  assert.equal(state.contentType, value.initialState.contentType, `${state.key} initial state content type changed`)
  assert.deepEqual(state.metadata, value.initialState.metadata, `${state.key} initial state metadata changed`)
  assertSstStateCheckpoint(state.body.toString('utf8'), { app, stage, requireEmpty: true })
  const sentinel = readVersionedObject({ aws, bucket: bootstrap.state, key: value.unlockSentinel.key, version: value.unlockSentinel.versionId, directoryFactory })
  assert.equal(sentinel.sha256, value.unlockSentinel.sha256, `${sentinel.key} initial sentinel digest changed`)
  assert.equal(sentinel.eTag, value.unlockSentinel.eTag, `${sentinel.key} initial sentinel ETag changed`)
  assert.equal(sentinel.byteLength, value.unlockSentinel.byteLength, `${sentinel.key} initial sentinel length changed`)
  assert.equal(sentinel.contentType, value.unlockSentinel.contentType, `${sentinel.key} initial sentinel content type changed`)
  assert.deepEqual(sentinel.metadata, value.unlockSentinel.metadata, `${sentinel.key} initial sentinel metadata changed`)
  assertEmptySentinel(sentinel, sentinel.key)
  for (const secret of value.secretObjects) {
    const passphrase = passphraseMap.get(`${secret.app}/${secret.stage}`)
    assert(passphrase, `${secret.key} passphrase receipt is missing`)
    const key = readPassphraseKey(aws, passphrase)
    try {
      assertSingleImmutableVersion(aws, bootstrap.state, secret.key, secret.versionId, `${secret.app}/${secret.stage} encrypted secret`)
      const stored = readVersionedObject({
        aws, bucket: bootstrap.state, key: secret.key, version: secret.versionId, directoryFactory,
        expectedMetadata: secret.metadata, expectedContentType: 'application/json',
      })
      assert.equal(stored.sha256, secret.sha256, `${secret.key} encrypted body digest changed`)
      assert.equal(stored.eTag, secret.eTag, `${secret.key} encrypted body ETag changed`)
      assert.equal(stored.byteLength, secret.byteLength, `${secret.key} encrypted body length changed`)
      assert.equal(stored.contentType, secret.contentType, `${secret.key} encrypted body content type changed`)
      assertEncryptedEmptyDocument(stored.body, key, secret.key)
    } finally { key.fill(0) }
  }
  return { app, stage, created: false, resourceTypes: value.initialState.resourceTypes, terminal: pointerWithoutBody(pointer) }
}

function assertGlobalTerminal(value, bootstrap) {
  exactKeys(value, ['schemaVersion', 'kind', 'state', 'operationId', 'binding', 'bindingSha256', 'bootstrap', 'reviewed', 'activeMarker', 'passphrases', 'secretObjects', 'homeTerminals', 'initialRetainedVersionInventory', 'failureReceiptPrefix', 'startedAt', 'completedAt', 'activeMarkerCurrentState'], 'SST global terminal receipt')
  assert.equal(value.schemaVersion, schemaVersion)
  assert.equal(value.kind, 'work-1.2-sst-home-initialization-terminal')
  assert.equal(value.state, 'completed')
  assert.match(value.operationId, /^sstinit-[a-f0-9]{32}$/)
  assertBinding(value.binding, bootstrap)
  assert.equal(value.bindingSha256, sha256(JSON.stringify(value.binding)), 'SST global terminal binding digest changed')
  assert.deepEqual(value.bootstrap, value.binding.bootstrap)
  assert.deepEqual(value.reviewed, value.binding.reviewed)
  exactKeys(value.activeMarker, ['key', 'versionId', 'sha256', 'resumeTokenSha256'], 'SST terminal active marker pointer')
  assert.equal(value.activeMarker.key, SST_INIT_ACTIVE_KEY)
  versionId(value.activeMarker.versionId, 'SST terminal active marker pointer')
  assert.match(value.activeMarker.sha256, /^[a-f0-9]{64}$/)
  assert.match(value.activeMarker.resumeTokenSha256, /^[a-f0-9]{64}$/)
  assert.equal(value.passphrases.length, 6)
  assert.equal(value.secretObjects.length, 6)
  assert.equal(value.homeTerminals.length, 4)
  assert.deepEqual(value.passphrases.map(item => `${item.app}/${item.stage}`), SST_PASSPHRASE_IDENTITIES.map(item => `${item.app}/${item.stage}`), 'SST global terminal passphrase identities changed')
  assert.deepEqual(value.secretObjects.map(item => `${item.app}/${item.stage}/${item.key}`), SST_PASSPHRASE_IDENTITIES.map(item => `${item.app}/${item.stage}/${sstSecretKey(item.app, item.stage)}`), 'SST global terminal secret identities changed')
  assert.deepEqual(value.homeTerminals.map(item => `${item.app}/${item.stage}/${item.key}`), SST_HOME_IDENTITIES.map(item => `${item.app}/${item.stage}/${sstInitTerminalKey(item.app, item.stage)}`), 'SST global terminal home identities changed')
  for (const item of value.passphrases) assertPassphraseRecord(item, item.app, item.stage, value.bindingSha256)
  for (const item of value.secretObjects) assertSecretRecord(item, item.app, item.stage, value.bindingSha256)
  for (const item of value.homeTerminals) {
    exactKeys(item, ['app', 'stage', 'key', 'versionId', 'sha256', 'byteLength'], 'SST home terminal pointer')
    versionId(item.versionId, `${item.key} pointer`)
    assert.match(item.sha256, /^[a-f0-9]{64}$/)
    assert(Number.isSafeInteger(item.byteLength) && item.byteLength > 0, `${item.key} pointer length is invalid`)
  }
  assert(Array.isArray(value.initialRetainedVersionInventory) && value.initialRetainedVersionInventory.length > 0, 'SST terminal retained inventory is empty')
  assert.equal(value.failureReceiptPrefix, failurePrefix)
  assert.equal(value.activeMarkerCurrentState, 'absent-after-success')
  iso(value.startedAt, 'SST global start time')
  iso(value.completedAt, 'SST global completion time')
  assert(new Date(value.completedAt) >= new Date(value.startedAt), 'SST global terminal completed before it started')
  return value
}

function verifyCompleted({ aws, bootstrap, terminal, directoryFactory, resumeToken, expected }) {
  const value = assertGlobalTerminal(terminal.value, bootstrap)
  assert.equal(terminal.pointer.key, SST_INIT_TERMINAL_KEY, 'SST global terminal key changed')
  assertSingleImmutableVersion(
    aws,
    bootstrap.state,
    SST_INIT_TERMINAL_KEY,
    terminal.pointer.versionId,
    'SST global terminal',
  )
  if (expected) {
    assert.deepEqual(value.binding, expected.binding, 'completed SST initialization belongs to different reviewed inputs')
    assert.equal(value.bindingSha256, expected.bindingSha256, 'completed SST initialization binding digest changed')
  }
  const passphraseMap = new Map()
  for (const expected of value.passphrases) {
    assertPassphraseRecord(expected, expected.app, expected.stage, value.bindingSha256)
    const metadata = tryPassphraseMetadata(aws, expected.app, expected.stage)
    assert(metadata, `${expected.name} is absent after completed initialization`)
    const observed = passphraseRecord(aws, expected.app, expected.stage, value.bindingSha256, metadata)
    assert.deepEqual(observed, expected, `${expected.name} no longer matches its terminal receipt`)
    passphraseMap.set(`${expected.app}/${expected.stage}`, observed)
  }
  const secretMap = new Map(value.secretObjects.map(expected => {
    assertSecretRecord(expected, expected.app, expected.stage, value.bindingSha256)
    return [`${expected.app}/${expected.stage}`, expected]
  }))
  const homes = value.homeTerminals.map(expected => {
    exactKeys(expected, ['app', 'stage', 'key', 'versionId', 'sha256', 'byteLength'], 'SST home terminal pointer')
    const read = readJsonPointer({ aws, bucket: bootstrap.state, key: expected.key, version: expected.versionId, directoryFactory })
    assert.equal(read.pointer.sha256, expected.sha256, `${expected.key} digest changed`)
    assert.equal(read.pointer.byteLength, expected.byteLength, `${expected.key} length changed`)
    return verifyHomeTerminal({
      aws, bootstrap, value: read.value, pointer: read.pointer,
      bindingSha256: value.bindingSha256, operationId: value.operationId,
      directoryFactory, passphraseMap, secretMap,
    })
  })
  const observedRetainedVersionInventory = assertInventoryRetained(aws, bootstrap.state, value.initialRetainedVersionInventory)
  const historicalActive = readJsonPointer({
    aws, bucket: bootstrap.state, key: value.activeMarker.key,
    version: value.activeMarker.versionId, directoryFactory,
  })
  assert.equal(historicalActive.pointer.sha256, value.activeMarker.sha256, 'terminal active marker digest changed')
  const checkedHistoricalActive = assertActive(historicalActive.value, bootstrap)
  assert.equal(checkedHistoricalActive.resumeTokenSha256, value.activeMarker.resumeTokenSha256, 'terminal active marker token binding changed')
  const active = readCurrentJson({ aws, bucket: bootstrap.state, key: SST_INIT_ACTIVE_KEY, directoryFactory })
  let activeMarkerToSeal
  if (active) {
    const checked = assertActive(active.value, bootstrap)
    assert.equal(active.pointer.versionId, value.activeMarker.versionId, 'terminal references a different active marker version')
    assert.equal(active.pointer.sha256, value.activeMarker.sha256, 'terminal references a different active marker digest')
    if (typeof resumeToken !== 'string' || sha256(resumeToken) !== checked.resumeTokenSha256) {
      throw new Error('completed SST initialization still has its active marker; the exact resume token is required to finish sealing')
    }
    activeMarkerToSeal = active.pointer
  }
  const activeHistory = exactKeyHistory(aws, bootstrap.state, SST_INIT_ACTIVE_KEY)
  const activeVersions = activeHistory.filter(item => item.kind === 'version')
  const activeDeleteMarkers = activeHistory.filter(item => item.kind === 'delete-marker')
  assert.equal(activeVersions.length, 1, 'SST initialization must retain exactly one active marker version')
  assert.equal(activeVersions[0].versionId, value.activeMarker.versionId, 'SST initialization retained a different active marker version')
  if (activeMarkerToSeal) {
    assert.equal(activeHistory.length, 1, 'unsealed SST initialization active history contains an unexpected record')
    assert.equal(activeVersions[0].isLatest, true, 'unsealed SST initialization active marker is not current')
  } else {
    assert.equal(activeHistory.length, 2, 'sealed SST initialization active history changed')
    assert.equal(activeVersions[0].isLatest, false, 'sealed SST initialization active value remained latest')
    assert.equal(activeDeleteMarkers.length, 1, 'SST initialization active marker delete marker is absent or duplicated')
    assert.equal(activeDeleteMarkers[0].isLatest, true, 'SST initialization active delete marker is not latest')
  }
  return {
    schemaVersion, replay: true, operationId: value.operationId, bindingSha256: value.bindingSha256,
    terminal: pointerWithoutBody(terminal.pointer), homes,
    externalCustody: {
      bootstrap: value.bootstrap,
      reviewed: value.reviewed,
      activeMarker: value.activeMarker,
      activeMarkerCurrentState: 'absent',
      activeMarkerHistory: activeHistory,
      passphrases: value.passphrases,
      secretObjects: value.secretObjects,
      homeTerminals: value.homeTerminals,
      initialRetainedVersionInventory: value.initialRetainedVersionInventory,
      observedRetainedVersionInventory,
      failureReceiptPrefix: value.failureReceiptPrefix,
    },
    activeMarkerToSeal,
  }
}

export function inspectCompletedSstInitialization({ aws, bootstrap, directoryFactory }) {
  const terminal = readCurrentJson({ aws, bucket: bootstrap.state, key: SST_INIT_TERMINAL_KEY, directoryFactory })
  if (!terminal) throw new Error('SST initialization global terminal receipt is absent')
  const { activeMarkerToSeal: _activeMarkerToSeal, ...result } = verifyCompleted({ aws, bootstrap, terminal, directoryFactory })
  return result
}

function writeFailure({ aws, bootstrap, active, activePointer, bindingSha256, phase, error, failedAt, directoryFactory, resumeToken, randomBytes }) {
  const message = (error instanceof Error ? error.message : String(error)).replaceAll(resumeToken, '[redacted]').slice(0, 2000)
  const attemptId = randomBytes(8).toString('hex')
  assert.match(attemptId, /^[a-f0-9]{16}$/)
  const key = `${failurePrefix}${active.operationId}/${failedAt.replace(/[:.]/g, '-')}-${attemptId}.json`
  const value = {
    schemaVersion, kind: 'work-1.2-sst-home-initialization-failure', state: 'failed',
    operationId: active.operationId, bindingSha256, phase,
    activeMarker: { key: SST_INIT_ACTIVE_KEY, versionId: activePointer.versionId, sha256: activePointer.sha256 },
    error: { name: error instanceof Error ? error.name : 'Error', message },
    failedAt, activeMarkerDisposition: 'retained-for-explicit-token-resume',
  }
  return putJsonCreateOnly({
    aws, bucket: bootstrap.state, key, kind: 'sst-initialization-failure', bindingSha256, directoryFactory,
  }, value)
}

function createHome({ aws, bootstrap, active, app, stage, passphrases, secrets, runEmptyDeploy, now, directoryFactory }) {
  const terminalKey = sstInitTerminalKey(app, stage)
  const existing = readCurrentJson({ aws, bucket: bootstrap.state, key: terminalKey, directoryFactory })
  const passphraseMap = new Map(passphrases.map(value => [`${value.app}/${value.stage}`, value]))
  if (existing) return verifyHomeTerminal({
    aws, bootstrap, value: existing.value, pointer: existing.pointer,
    bindingSha256: active.bindingSha256, operationId: active.operationId,
    directoryFactory, passphraseMap, secretMap: secrets,
  })
  const startedAt = iso(now(), `${app}/${stage} start time`)
  ensureSstUnlockSentinel({ aws, bootstrap, app, stage, bindingSha256: active.bindingSha256, directoryFactory })
  const priorState = readCurrentObject({ aws, bucket: bootstrap.state, key: sstStateKey(app, stage), directoryFactory })
  if (priorState) assertSstStateCheckpoint(priorState.body.toString('utf8'), { app, stage, requireEmpty: true })
  // A checkpoint alone is not proof that the deploy succeeded: SST can write
  // state before exiting nonzero. Until a terminal exists, rerun the reviewed
  // idempotent empty deployment and require its successful exit.
  const status = runEmptyDeploy({ app, stage })
  assert.equal(status, 0, `${app}/${stage} empty SST deployment failed with exit ${status}`)
  const unlockSentinel = ensureSstUnlockSentinel({ aws, bootstrap, app, stage, bindingSha256: active.bindingSha256, directoryFactory })
  const initialState = stateRecord({ aws, bootstrap, app, stage, directoryFactory })
  const value = assertHomeTerminal({
    schemaVersion, kind: 'work-1.2-sst-home-terminal', state: 'completed',
    operationId: active.operationId, bindingSha256: active.bindingSha256,
    home: { app, stage },
    passphrases: [passphraseMap.get(`${app}/${stage}`), passphraseMap.get(`${app}/_fallback`)],
    secretObjects: [secrets.get(`${app}/${stage}`), secrets.get(`${app}/_fallback`)],
    initialState, unlockSentinel, startedAt, completedAt: iso(now(), `${app}/${stage} completion time`),
  }, { app, stage, bindingSha256: active.bindingSha256, operationId: active.operationId })
  const pointer = putJsonCreateOnly({
    aws, bucket: bootstrap.state, key: terminalKey, kind: 'sst-home-terminal',
    bindingSha256: active.bindingSha256, directoryFactory,
  }, value)
  const readback = readJsonPointer({ aws, bucket: bootstrap.state, key: terminalKey, version: pointer.versionId, directoryFactory })
  assert.deepEqual(readback.value, value, `${terminalKey} create-only readback changed`)
  return { app, stage, created: true, resourceTypes: initialState.resourceTypes, terminal: pointerWithoutBody(pointer) }
}

export function ensureEmptySstHomeStates({
  aws,
  putSecureParameter,
  runEmptyDeploy,
  bootstrap,
  reviewed,
  now = () => new Date(),
  directoryFactory,
  randomBytes = systemRandomBytes,
  resumeToken,
}) {
  assert.equal(typeof aws, 'function', 'AWS command boundary is required')
  assert.equal(typeof putSecureParameter, 'function', 'secure SSM stdin boundary is required')
  assert.equal(typeof runEmptyDeploy, 'function', 'empty SST deploy boundary is required')
  assert(bootstrap && typeof bootstrap === 'object', 'existing SST bootstrap readback is required')
  assert.match(resumeToken ?? '', /^[A-Za-z0-9_-]{43}$/, 'a pre-generated SST initialization resume token is required')
  const expected = bindingFor(bootstrap, reviewed)
  const terminal = readCurrentJson({ aws, bucket: bootstrap.state, key: SST_INIT_TERMINAL_KEY, directoryFactory })
  if (terminal) {
    const verified = verifyCompleted({ aws, bootstrap, terminal, directoryFactory, resumeToken, expected })
    const { activeMarkerToSeal, ...verifiedResult } = verified
    if (!activeMarkerToSeal) return verifiedResult
    const { externalCustody: _externalCustody, ...sealedResult } = verifiedResult
    sealActiveMarker(aws, bootstrap.state, activeMarkerToSeal)
    return sealedResult
  }
  let activeRead = readCurrentJson({ aws, bucket: bootstrap.state, key: SST_INIT_ACTIVE_KEY, directoryFactory })
  const rawResumeToken = resumeToken
  if (!activeRead) {
    assertFreshNamespaces(aws, bootstrap.state)
    for (const { app, stage } of SST_PASSPHRASE_IDENTITIES) {
      assert.equal(tryPassphraseMetadata(aws, app, stage), undefined, `${sstPassphraseParameter(app, stage)} already exists without an initialization terminal`)
    }
    const active = activeValue({
      operationId: `sstinit-${randomBytes(16).toString('hex')}`,
      binding: expected.binding,
      bindingSha256: expected.bindingSha256,
      resumeTokenSha256: sha256(rawResumeToken),
      startedAt: iso(now(), 'SST initialization start time'),
    })
    const pointer = putJsonCreateOnly({
      aws, bucket: bootstrap.state, key: SST_INIT_ACTIVE_KEY, kind: 'sst-initialization-active',
      bindingSha256: active.bindingSha256, directoryFactory,
    }, active)
    activeRead = { value: active, pointer: pointerWithoutBody(pointer) }
  }

  const active = assertActive(activeRead.value, bootstrap)
  assert.deepEqual(active.binding, expected.binding, 'active SST initialization belongs to different reviewed inputs')
  assert.equal(active.bindingSha256, expected.bindingSha256)
  if (typeof rawResumeToken !== 'string' || sha256(rawResumeToken) !== active.resumeTokenSha256) {
    throw new Error('active SST initialization requires the exact resume token')
  }

  let phase = 'passphrases'
  let preparedResult
  let markerToSeal
  try {
    const passphrases = SST_PASSPHRASE_IDENTITIES.map(({ app, stage }) => ensurePassphrase({
      aws, putSecureParameter, app, stage, bindingSha256: active.bindingSha256, randomBytes,
    }))
    phase = 'encrypted-secrets'
    const secrets = new Map()
    for (const passphrase of passphrases) {
      const secret = ensureEncryptedSecret({
        aws, bootstrap, app: passphrase.app, stage: passphrase.stage,
        bindingSha256: active.bindingSha256, passphrase, directoryFactory, randomBytes,
      })
      secrets.set(`${passphrase.app}/${passphrase.stage}`, secret)
    }
    phase = 'empty-homes'
    const homes = SST_HOME_IDENTITIES.map(({ app, stage }) => createHome({
      aws, bootstrap, active, app, stage, passphrases, secrets,
      runEmptyDeploy, now, directoryFactory,
    }))
    phase = 'global-terminal'
    const homeTerminals = homes.map(value => ({
      app: value.app, stage: value.stage, key: value.terminal.key,
      versionId: value.terminal.versionId, sha256: value.terminal.sha256, byteLength: value.terminal.byteLength,
    }))
    const value = assertGlobalTerminal({
      schemaVersion, kind: 'work-1.2-sst-home-initialization-terminal', state: 'completed',
      operationId: active.operationId, binding: active.binding, bindingSha256: active.bindingSha256,
      bootstrap: active.binding.bootstrap, reviewed: active.binding.reviewed,
      activeMarker: {
        key: SST_INIT_ACTIVE_KEY, versionId: activeRead.pointer.versionId,
        sha256: activeRead.pointer.sha256, resumeTokenSha256: active.resumeTokenSha256,
      },
      passphrases,
      secretObjects: [...secrets.values()],
      homeTerminals,
      initialRetainedVersionInventory: captureInitialInventory(aws, bootstrap.state),
      failureReceiptPrefix: failurePrefix,
      startedAt: active.startedAt,
      completedAt: iso(now(), 'SST global completion time'),
      activeMarkerCurrentState: 'absent-after-success',
    }, bootstrap)
    const pointer = putJsonCreateOnly({
      aws, bucket: bootstrap.state, key: SST_INIT_TERMINAL_KEY,
      kind: 'sst-initialization-terminal', bindingSha256: active.bindingSha256, directoryFactory,
    }, value)
    const readback = readJsonPointer({ aws, bucket: bootstrap.state, key: SST_INIT_TERMINAL_KEY, version: pointer.versionId, directoryFactory })
    assert.deepEqual(readback.value, value, 'SST global terminal create-only readback changed')
    const verified = verifyCompleted({
      aws, bootstrap, terminal: readback, directoryFactory, expected, resumeToken: rawResumeToken,
    })
    assert(verified.activeMarkerToSeal, 'fresh SST initialization lost its active marker before sealing')
    markerToSeal = verified.activeMarkerToSeal
    preparedResult = {
      schemaVersion, replay: false, operationId: active.operationId, bindingSha256: active.bindingSha256,
      terminal: pointerWithoutBody(pointer), homes,
    }
  } catch (error) {
    try {
      writeFailure({
        aws, bootstrap, active, activePointer: activeRead.pointer, bindingSha256: active.bindingSha256,
        phase, error, failedAt: iso(now(), 'SST initialization failure time'), directoryFactory,
        resumeToken: rawResumeToken, randomBytes,
      })
    } catch (failureError) {
      throw new AggregateError([error, failureError], 'SST initialization failed and its durable failure receipt could not be written')
    }
    throw error
  }
  // This conditional delete is the final external action. There is no
  // fallible readback or failure-receipt write after a successful seal.
  sealActiveMarker(aws, bootstrap.state, markerToSeal)
  return preparedResult
}

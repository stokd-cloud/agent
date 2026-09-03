import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ensureEmptySstHomeStates,
  inspectCompletedSstInitialization,
} from '../../scripts/infra-initialize-sst-home.mjs'
import { inspectExistingSstBootstrap } from '../../scripts/infra-bootstrap.mjs'
import {
  SST_INIT_ACTIVE_KEY,
  SST_INIT_PREFIX,
  SST_INIT_TERMINAL_KEY,
  SST_PASSPHRASE_DESCRIPTION,
  SST_PASSPHRASE_IDENTITIES,
  assertSstStateCheckpoint,
  parseSstBootstrapParameter,
  parseSstStateHistory,
  sstPassphraseParameter,
  sstSecretKey,
  sstStateKey,
} from '../../scripts/infra-sst-bootstrap.mjs'

const accountId = '167217327520'
const region = 'us-east-1'
const stateBucket = 'sst-state-owtaxdsakxdh'
const bootstrapValue = JSON.stringify({
  version: 5,
  asset: 'sst-asset-owtaxdsakxdh',
  assetEcrRegistryId: accountId,
  assetEcrUrl: `${accountId}.dkr.ecr.${region}.amazonaws.com/sst-asset`,
  state: stateBucket,
  appsyncHttp: '',
  appsyncRealtime: '',
})
const bootstrapEnvelope = JSON.stringify({
  Parameter: { Name: '/sst/bootstrap', Type: 'String', Version: 5, Value: bootstrapValue },
})
const bootstrap = parseSstBootstrapParameter(bootstrapEnvelope)
const reviewed = Object.freeze({
  reviewedSourceSha256: 'a'.repeat(64),
  emptyConfigSha256: 'b'.repeat(64),
  initializerSha256: 'c'.repeat(64),
  sstVersion: '3.19.3',
  pulumiVersion: '3.210.0',
  sstPackageSha256: 'd'.repeat(64),
  sstLauncherSha256: 'e'.repeat(64),
  sstNativePackageSha256: 'f'.repeat(64),
  sstBinarySha256: '0'.repeat(64),
})

function flag(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function md5(body) {
  return `\"${createHash('md5').update(body).digest('hex')}\"`
}

function emptyCheckpoint(app, stage, extraResource) {
  const resources = [{
    urn: `urn:pulumi:${stage}::${app}::pulumi:pulumi:Stack::${app}-${stage}`,
    custom: false,
    type: 'pulumi:pulumi:Stack',
    outputs: { _protect: true },
  }, ...extraResource ? [extraResource] : []]
  return JSON.stringify({
    version: 3,
    checkpoint: {
      stack: `organization/${app}/${stage}`,
      latest: {
        manifest: {
          time: '2026-09-02T12:00:00.000Z',
          magic: 'a'.repeat(64),
          version: 'v3.210.0',
          plugins: [],
        },
        secrets_providers: {
          type: 'passphrase',
          state: { salt: 'v1:QUFBQQ==:v1:QkJCQg==:Q0NDQw==' },
        },
        resources,
        pending_operations: [],
      },
    },
  })
}

class AwsMemory {
  constructor() {
    this.calls = []
    this.listObjectResponses = []
    this.objects = new Map()
    this.parameters = new Map()
    this.generatedSecrets = []
    this.temporaryDirectories = []
    this.versionSequence = 0
    this.randomSequence = 0
    this.timeSequence = 0
    this.deployCount = 0
    this.deployWrites = 0
    this.secureParameterWrites = 0
    this.failDeployAt = undefined
    this.failDeployWritesState = false
    this.resumeToken = Buffer.alloc(32, 91).toString('base64url')

    this.aws = this.aws.bind(this)
    this.putSecureParameter = this.putSecureParameter.bind(this)
    this.runEmptyDeploy = this.runEmptyDeploy.bind(this)
    this.randomBytes = this.randomBytes.bind(this)
    this.now = this.now.bind(this)
    this.directoryFactory = this.directoryFactory.bind(this)
  }

  directoryFactory() {
    const path = mkdtempSync(join(tmpdir(), 'sst-home-aws-fixture-'))
    this.temporaryDirectories.push(path)
    return path
  }

  now() {
    const value = new Date(Date.UTC(2026, 8, 2, 12, 0, this.timeSequence))
    this.timeSequence += 1
    return value
  }

  randomBytes(length) {
    this.randomSequence += 1
    const value = Buffer.alloc(length)
    for (let index = 0; index < length; index += 1) {
      value[index] = (this.randomSequence * 29 + index * 17) % 256
    }
    return value
  }

  nextVersionId() {
    this.versionSequence += 1
    return `version-${String(this.versionSequence).padStart(6, '0')}`
  }

  versions(key) {
    if (!this.objects.has(key)) this.objects.set(key, [])
    return this.objects.get(key)
  }

  currentEntry(key) {
    return this.objects.get(key)?.at(-1)
  }

  visibleEntry(key) {
    const value = this.currentEntry(key)
    return value && !value.deleteMarker ? value : undefined
  }

  exactEntry(key, versionId) {
    return this.objects.get(key)?.find(value => value.versionId === versionId)
  }

  putStoredObject(key, body, {
    contentType = 'application/json',
    metadata = {},
    serverSideEncryption = 'AES256',
  } = {}) {
    const bytes = Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body)
    const entry = {
      key,
      versionId: this.nextVersionId(),
      deleteMarker: false,
      body: bytes,
      contentType,
      metadata: { ...metadata },
      serverSideEncryption,
      eTag: md5(bytes),
      lastModified: this.now().toISOString(),
    }
    this.versions(key).push(entry)
    return entry
  }

  deleteCurrent(key) {
    const entry = {
      key,
      versionId: this.nextVersionId(),
      deleteMarker: true,
      lastModified: this.now().toISOString(),
    }
    this.versions(key).push(entry)
    return entry
  }

  mutationCount() {
    const awsMutations = this.calls.filter(args => (
      (args[0] === 's3api' && ['put-object', 'delete-object'].includes(args[1]))
      || (args[0] === 'ssm' && args[1] === 'put-parameter')
    )).length
    return awsMutations + this.deployWrites + this.secureParameterWrites
  }

  commandBodyPath(args) {
    if (args[0] === 's3api' && args[1] === 'get-object') return args.at(-1)
    return flag(args, '--body')
  }

  head(entry) {
    return {
      ContentLength: entry.body.byteLength,
      ContentType: entry.contentType,
      ETag: entry.eTag,
      Metadata: { ...entry.metadata },
      ServerSideEncryption: entry.serverSideEncryption,
      VersionId: entry.versionId,
    }
  }

  aws(args) {
    this.calls.push([...args])
    const command = `${args[0]} ${args[1]}`
    if (command === 's3api list-objects-v2') {
      const prefix = flag(args, '--prefix')
      const contents = [...this.objects.keys()]
        .filter(key => key.startsWith(prefix))
        .map(key => this.visibleEntry(key))
        .filter(Boolean)
        .sort((left, right) => left.key.localeCompare(right.key))
        .map(entry => ({
          Key: entry.key,
          LastModified: entry.lastModified,
          ETag: entry.eTag,
          Size: entry.body.byteLength,
          StorageClass: 'STANDARD',
        }))
      const response = { IsTruncated: false, KeyCount: contents.length, Contents: contents }
      this.listObjectResponses.push(structuredClone(response))
      return JSON.stringify(response)
    }
    if (command === 's3api head-object') {
      const key = flag(args, '--key')
      const requestedVersion = flag(args, '--version-id')
      const entry = requestedVersion ? this.exactEntry(key, requestedVersion) : this.visibleEntry(key)
      if (!entry || entry.deleteMarker) throw new Error(`NoSuchKey: ${key}${requestedVersion ? ` version ${requestedVersion}` : ''}`)
      return JSON.stringify(this.head(entry))
    }
    if (command === 's3api get-object') {
      const key = flag(args, '--key')
      const requestedVersion = flag(args, '--version-id')
      const entry = requestedVersion ? this.exactEntry(key, requestedVersion) : this.visibleEntry(key)
      if (!entry || entry.deleteMarker) throw new Error(`NoSuchVersion: ${key} version ${requestedVersion ?? '<current>'}`)
      writeFileSync(this.commandBodyPath(args), entry.body)
      return JSON.stringify({
        ETag: entry.eTag,
        ServerSideEncryption: entry.serverSideEncryption,
        VersionId: entry.versionId,
      })
    }
    if (command === 's3api put-object') {
      const key = flag(args, '--key')
      if (flag(args, '--if-none-match') === '*' && this.visibleEntry(key)) {
        throw new Error(`PreconditionFailed: ${key} already has a current object`)
      }
      const metadata = Object.fromEntries((flag(args, '--metadata') ?? '')
        .split(',').filter(Boolean).map(value => value.split('=')))
      const entry = this.putStoredObject(key, readFileSync(this.commandBodyPath(args)), {
        contentType: flag(args, '--content-type'),
        metadata,
        serverSideEncryption: flag(args, '--server-side-encryption'),
      })
      return JSON.stringify({ ETag: entry.eTag, ServerSideEncryption: entry.serverSideEncryption, VersionId: entry.versionId })
    }
    if (command === 's3api delete-object') {
      const key = flag(args, '--key')
      const requestedVersion = flag(args, '--version-id')
      if (requestedVersion) {
        const versions = this.versions(key)
        const index = versions.findIndex(value => value.versionId === requestedVersion)
        if (index === -1) throw new Error(`NoSuchVersion: ${key} version ${requestedVersion}`)
        const [removed] = versions.splice(index, 1)
        return JSON.stringify({ DeleteMarker: removed.deleteMarker || undefined, VersionId: requestedVersion })
      }
      const current = this.visibleEntry(key)
      if (flag(args, '--if-match') !== undefined) assert.equal(flag(args, '--if-match'), current?.eTag)
      if (flag(args, '--if-match-size') !== undefined) assert.equal(Number(flag(args, '--if-match-size')), current?.body.byteLength)
      const marker = this.deleteCurrent(key)
      return JSON.stringify({ DeleteMarker: true, VersionId: marker.versionId })
    }
    if (command === 's3api list-object-versions') {
      const prefix = flag(args, '--prefix')
      const versions = []
      const deleteMarkers = []
      for (const [key, entries] of [...this.objects.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        if (!key.startsWith(prefix)) continue
        entries.forEach((entry, index) => {
          const common = {
            Key: key,
            VersionId: entry.versionId,
            IsLatest: index === entries.length - 1,
            LastModified: entry.lastModified,
          }
          if (entry.deleteMarker) deleteMarkers.push(common)
          else versions.push({ ...common, ETag: entry.eTag, Size: entry.body.byteLength, StorageClass: 'STANDARD' })
        })
      }
      return JSON.stringify({ IsTruncated: false, Versions: versions, DeleteMarkers: deleteMarkers })
    }
    if (command === 'ssm describe-parameters') {
      const filter = flag(args, '--parameter-filters')
      const name = filter?.slice(filter.indexOf('Values=') + 'Values='.length)
      const value = this.parameters.get(name)
      return JSON.stringify({ Parameters: value ? [{
        Name: name,
        ARN: `arn:aws:ssm:${region}:${accountId}:parameter${name}`,
        Type: value.Type,
        KeyId: value.KeyId,
        Version: value.Version,
        Tier: value.Tier,
        DataType: value.DataType,
        Description: value.Description,
        Policies: [],
      }] : [] })
    }
    if (command === 'ssm list-tags-for-resource') {
      const value = this.parameters.get(flag(args, '--resource-id'))
      if (!value) throw new Error('ParameterNotFound')
      return JSON.stringify({ TagList: structuredClone(value.Tags) })
    }
    if (command === 'ssm get-parameter') {
      const name = flag(args, '--name')
      const value = this.parameters.get(name)
      if (!value) throw new Error(`ParameterNotFound: ${name}`)
      assert(args.includes('--with-decryption'), `${name} must be read with decryption`)
      return JSON.stringify({ Parameter: {
        Name: name,
        Type: value.Type,
        Version: value.Version,
        Value: value.Value,
      } })
    }
    throw new Error(`unexpected AWS call ${command}`)
  }

  putSecureParameter(payload) {
    assert.equal(payload.Overwrite, false)
    if (this.parameters.has(payload.Name)) throw new Error(`ParameterAlreadyExists: ${payload.Name}`)
    this.generatedSecrets.push(payload.Value)
    this.parameters.set(payload.Name, { ...structuredClone(payload), Version: 1 })
    this.secureParameterWrites += 1
    return JSON.stringify({ Version: 1, Tier: payload.Tier })
  }

  runEmptyDeploy({ app, stage }) {
    this.deployCount += 1
    if (this.failDeployAt === this.deployCount) {
      this.failDeployAt = undefined
      if (this.failDeployWritesState) {
        this.putStoredObject(sstStateKey(app, stage), emptyCheckpoint(app, stage))
        this.deployWrites += 1
      }
      return 37
    }
    this.putStoredObject(sstStateKey(app, stage), emptyCheckpoint(app, stage))
    this.deployWrites += 1
    return 0
  }

  options(overrides = {}) {
    return {
      aws: this.aws,
      putSecureParameter: this.putSecureParameter,
      runEmptyDeploy: this.runEmptyDeploy,
      bootstrap,
      reviewed,
      now: this.now,
      directoryFactory: this.directoryFactory,
      randomBytes: this.randomBytes,
      resumeToken: this.resumeToken,
      ...overrides,
    }
  }

  currentJson(key) {
    const entry = this.visibleEntry(key)
    return entry ? JSON.parse(entry.body.toString('utf8')) : undefined
  }

  replaceCurrentJson(key, transform) {
    const current = this.visibleEntry(key)
    assert(current, `${key} is not current`)
    const value = structuredClone(JSON.parse(current.body.toString('utf8')))
    transform(value)
    return this.putStoredObject(key, JSON.stringify(value), {
      contentType: current.contentType,
      metadata: current.metadata,
      serverSideEncryption: current.serverSideEncryption,
    })
  }
}

function assertNoPlaintextLeak(fixture, token) {
  assert.equal(fixture.generatedSecrets.length, 6)
  assert.equal(new Set(fixture.generatedSecrets).size, 6)
  for (const value of fixture.generatedSecrets) {
    assert.match(value, /^[A-Za-z0-9+/]{43}=$/)
    assert.equal(Buffer.from(value, 'base64').byteLength, 32)
  }
  const argv = fixture.calls.flat().join('\n')
  assert(!argv.includes(token), 'resume token leaked into AWS argv')
  for (const value of fixture.generatedSecrets) assert(!argv.includes(value), 'passphrase leaked into AWS argv')
  for (const path of fixture.temporaryDirectories) assert.equal(existsSync(path), false, `${path} survived secure cleanup`)
  const receipts = [...fixture.objects.entries()]
    .filter(([key]) => key.startsWith(SST_INIT_PREFIX))
    .flatMap(([, entries]) => entries.filter(value => !value.deleteMarker).map(value => value.body.toString('utf8')))
    .join('\n')
  assert(!receipts.includes(token), 'resume token leaked into an initialization receipt')
  for (const value of fixture.generatedSecrets) assert(!receipts.includes(value), 'passphrase leaked into an initialization receipt')
}

test('existing SST bootstrap parsing is exact and fail closed', () => {
  const parsed = parseSstBootstrapParameter(bootstrapEnvelope)
  assert.equal(parsed.state, stateBucket)
  assert.equal(parsed.asset, 'sst-asset-owtaxdsakxdh')
  assert.match(parsed.sha256, /^[a-f0-9]{64}$/)
  for (const mutation of [
    { version: 4 },
    { state: `sst-state-${accountId}-${region}` },
    { assetEcrUrl: `${accountId}.dkr.ecr.${region}.amazonaws.com/other` },
    { appsyncHttp: 'https://unexpected.example' },
    { extra: true },
  ]) {
    const value = { ...JSON.parse(bootstrapValue), ...mutation }
    assert.throws(() => parseSstBootstrapParameter(JSON.stringify({
      Parameter: { Name: '/sst/bootstrap', Type: 'String', Version: 5, Value: JSON.stringify(value) },
    })))
  }
  assert.throws(() => parseSstBootstrapParameter(JSON.stringify({
    Parameter: { Name: '/sst/other', Type: 'String', Version: 5, Value: bootstrapValue },
  })), /name changed/)
})

test('SST version-history parser accepts AWS CLI timestamps and preserves delete markers', () => {
  const prefix = 'app/stokd-agent-data/source-val12.json'
  const records = parseSstStateHistory(JSON.stringify({
    Versions: [{
      Key: prefix,
      VersionId: 'version-1',
      IsLatest: false,
      LastModified: '2026-09-02T12:00:00+00:00',
      ETag: '\"d41d8cd98f00b204e9800998ecf8427e\"',
      Size: 0,
    }],
    DeleteMarkers: [{
      Key: prefix,
      VersionId: 'marker-2',
      IsLatest: true,
      LastModified: '2026-09-02T12:00:01+00:00',
    }],
  }), prefix)
  assert.deepEqual(records.map(value => value.kind), ['delete-marker', 'version'])
  assert.equal(records.find(value => value.kind === 'version').lastModified, '2026-09-02T12:00:00.000Z')
  assert.throws(() => parseSstStateHistory(JSON.stringify({ Versions: [{
    Key: prefix,
    VersionId: 'version-1',
    IsLatest: true,
    LastModified: 'not-a-date',
    ETag: '\"d41d8cd98f00b204e9800998ecf8427e\"',
    Size: 0,
  }] }), prefix), /invalid LastModified/)
})

test('administrator bootstrap verifies existing state, asset, ECR, and state-bucket controls', () => {
  const calls = []
  const result = inspectExistingSstBootstrap(args => {
    calls.push(args)
    const command = `${args[0]} ${args[1]}`
    if (command === 'ssm get-parameter') return bootstrapEnvelope
    if (command === 's3api get-bucket-location') return JSON.stringify({ LocationConstraint: null })
    if (command === 's3api get-bucket-versioning') return JSON.stringify({ Status: 'Enabled' })
    if (command === 's3api get-bucket-encryption') return JSON.stringify({
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: false }],
      },
    })
    if (command === 's3api get-public-access-block') return JSON.stringify({
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    })
    if (command === 's3api get-bucket-ownership-controls') return JSON.stringify({
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    })
    if (command === 's3api get-bucket-policy') return JSON.stringify({
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Sid: 'DenyInsecureTransport',
          Effect: 'Deny',
          Principal: '*',
          Action: 's3:*',
          Resource: [`arn:aws:s3:::${stateBucket}`, `arn:aws:s3:::${stateBucket}/*`],
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        }],
      }),
    })
    if (command === 's3api get-bucket-lifecycle-configuration') return JSON.stringify({ Rules: [] })
    if (command === 'ecr describe-repositories') return JSON.stringify({ repositories: [{
      registryId: accountId,
      repositoryName: 'sst-asset',
      repositoryUri: `${accountId}.dkr.ecr.${region}.amazonaws.com/sst-asset`,
      repositoryArn: `arn:aws:ecr:${region}:${accountId}:repository/sst-asset`,
    }] })
    throw new Error(`unexpected ${command}`)
  })
  assert.equal(result.stateControls.versioning, 'Enabled')
  assert(calls.some(args => args.includes('/sst/bootstrap')))
  assert(calls.filter(args => args.includes('--expected-bucket-owner')).every(args => args.includes(accountId)))
})

test('fresh initialization uses AWS-faithful current/version reads, seals once, and replays read-only', () => {
  const fixture = new AwsMemory()
  const result = ensureEmptySstHomeStates(fixture.options())
  assert.equal(result.replay, false)
  assert.equal(result.homes.length, 4)
  assert(result.homes.every(value => value.created && value.resourceTypes.length === 1))
  assert.equal(fixture.deployCount, 4)
  assert.equal(fixture.parameters.size, 6)
  assert.match(fixture.resumeToken, /^[A-Za-z0-9_-]{43}$/)
  assert(fixture.listObjectResponses.length > 0)
  assert(fixture.listObjectResponses.every(response => response.Contents.every(value => !Object.hasOwn(value, 'VersionId'))), 'fixture leaked VersionId through ListObjectsV2')
  assert(fixture.calls.some(args => args[0] === 's3api' && args[1] === 'head-object' && !args.includes('--version-id')), 'initializer never discovered a current version through unversioned HEAD')
  assert(fixture.calls.some(args => args[0] === 's3api' && args[1] === 'head-object' && args.includes('--version-id')), 'initializer never verified an exact version through HEAD')
  assert(fixture.calls.some(args => args[0] === 's3api' && args[1] === 'get-object' && args.includes('--version-id')), 'initializer never verified an exact version through GET')

  for (const { app, stage } of SST_PASSPHRASE_IDENTITIES) {
    const parameter = fixture.parameters.get(sstPassphraseParameter(app, stage))
    assert(parameter, `${app}/${stage} passphrase was not created`)
    assert.equal(parameter.Type, 'SecureString')
    assert.equal(parameter.KeyId, 'alias/aws/ssm')
    assert.equal(parameter.Description, SST_PASSPHRASE_DESCRIPTION)
    assert.equal(parameter.Overwrite, false)
    assert.equal(parameter.Tier, 'Standard')
    assert.equal(parameter.DataType, 'text')
    const secret = fixture.visibleEntry(sstSecretKey(app, stage))
    assert(secret, `${app}/${stage} encrypted secret was not created`)
    assert.equal(secret.body.byteLength, 30)
    assert.notEqual(secret.body.toString('utf8'), '{}')
  }

  const token = fixture.resumeToken
  assertNoPlaintextLeak(fixture, token)
  assert.equal(fixture.visibleEntry(SST_INIT_ACTIVE_KEY), undefined, 'completed initialization left the active marker visible')
  const activeHistory = fixture.versions(SST_INIT_ACTIVE_KEY)
  assert.equal(activeHistory.length, 2, 'active history must retain its value and a delete marker')
  assert.equal(activeHistory[0].deleteMarker, false)
  assert.equal(activeHistory[1].deleteMarker, true)
  assert.equal(fixture.visibleEntry(SST_INIT_TERMINAL_KEY) !== undefined, true)

  const mutationsBeforeReplay = fixture.mutationCount()
  const replay = ensureEmptySstHomeStates(fixture.options())
  assert.equal(replay.replay, true)
  assert(replay.homes.every(value => value.created === false))
  assert.equal(fixture.mutationCount(), mutationsBeforeReplay, 'completed replay mutated cloud state')
  const inspected = inspectCompletedSstInitialization({
    aws: fixture.aws,
    bootstrap,
    directoryFactory: fixture.directoryFactory,
  })
  assert.equal(inspected.replay, true)
  assert.equal(fixture.mutationCount(), mutationsBeforeReplay, 'completed inspection mutated cloud state')
})

test('initialization refuses to create a cloud marker until the resume token exists', () => {
  const fixture = new AwsMemory()
  assert.throws(
    () => ensureEmptySstHomeStates(fixture.options({ resumeToken: undefined })),
    /pre-generated SST initialization resume token/,
  )
  assert.equal(fixture.mutationCount(), 0)
  assert.equal(fixture.visibleEntry(SST_INIT_ACTIVE_KEY), undefined)
})

test('crash retains the active marker; wrong token and binding drift refuse; exact-token resume completes', () => {
  const fixture = new AwsMemory()
  fixture.failDeployAt = 2
  fixture.failDeployWritesState = true
  assert.throws(() => ensureEmptySstHomeStates(fixture.options()), /failed with exit 37/)
  const token = fixture.resumeToken
  const active = fixture.visibleEntry(SST_INIT_ACTIVE_KEY)
  assert(active, 'failed initialization did not retain its active marker')
  assert.equal(fixture.versions(SST_INIT_ACTIVE_KEY).some(value => value.deleteMarker), false)
  const failures = [...fixture.objects.keys()].filter(key => key.startsWith(`${SST_INIT_PREFIX}failures/`))
  assert.equal(failures.length, 1, 'failed initialization did not write exactly one durable failure receipt')
  const failureBody = fixture.visibleEntry(failures[0]).body.toString('utf8')
  assert(!failureBody.includes(token), 'failure receipt leaked the resume token')

  const beforeWrongToken = fixture.mutationCount()
  assert.throws(() => ensureEmptySstHomeStates(fixture.options({ resumeToken: 'x'.repeat(43) })), /exact resume token/)
  assert.equal(fixture.mutationCount(), beforeWrongToken, 'wrong-token refusal mutated cloud state')

  const drifted = { ...reviewed, initializerSha256: '1'.repeat(64) }
  assert.throws(() => ensureEmptySstHomeStates(fixture.options({ reviewed: drifted, resumeToken: token })), /different reviewed inputs/)
  assert.equal(fixture.mutationCount(), beforeWrongToken, 'binding-drift refusal mutated cloud state')

  const resumed = ensureEmptySstHomeStates(fixture.options({ resumeToken: token }))
  assert.equal(resumed.replay, false)
  assert.equal(resumed.homes.filter(value => value.created).length, 3, 'resume did not preserve the completed home receipt')
  assert.equal(fixture.deployCount, 5, 'resume repeated a successfully sealed empty deployment')
  assert.equal(fixture.parameters.size, 6)
  assert.equal(fixture.visibleEntry(SST_INIT_ACTIVE_KEY), undefined)
  assert.equal(fixture.versions(SST_INIT_ACTIVE_KEY).at(-1).deleteMarker, true)
  assertNoPlaintextLeak(fixture, token)
})

test('concealed pre-existing versions and delete markers refuse first initialization', () => {
  const fixture = new AwsMemory()
  const key = sstStateKey('stokd-agent-data', 'source-val12')
  fixture.putStoredObject(key, emptyCheckpoint('stokd-agent-data', 'source-val12'))
  fixture.deleteCurrent(key)
  assert.equal(fixture.visibleEntry(key), undefined, 'seeded delete marker did not conceal the current object')
  assert.throws(() => ensureEmptySstHomeStates(fixture.options()), /already has retained state versions or delete markers/)
  assert.equal(fixture.parameters.size, 0)
  assert.equal(fixture.visibleEntry(SST_INIT_ACTIVE_KEY), undefined)
})

test('completed replay rejects a tampered terminal cross-link', () => {
  const fixture = new AwsMemory()
  ensureEmptySstHomeStates(fixture.options())
  const terminal = fixture.currentJson(SST_INIT_TERMINAL_KEY)
  assert.equal(terminal.homeTerminals.length, 4)
  fixture.replaceCurrentJson(SST_INIT_TERMINAL_KEY, value => {
    value.homeTerminals[0].versionId = value.homeTerminals[1].versionId
  })
  assert.throws(() => ensureEmptySstHomeStates(fixture.options()), /NoSuchKey|NoSuchVersion|exactly one retained version/)
})

test('empty checkpoint validation rejects any deployed provider resource', () => {
  const arbitrary = {
    urn: 'urn:pulumi:source-val12::stokd-agent-data::random:index/randomId:RandomId::bad',
    custom: true,
    type: 'random:index/randomId:RandomId',
    id: 'physical',
  }
  assert.throws(() => assertSstStateCheckpoint(
    emptyCheckpoint('stokd-agent-data', 'source-val12', arbitrary),
    { app: 'stokd-agent-data', stage: 'source-val12', requireEmpty: true },
  ), /resource count changed|created a non-stack resource/)
})

test('empty checkpoint validation binds the sole stack URN to the exact app and stage', () => {
  const wrong = JSON.parse(emptyCheckpoint('stokd-agent-data', 'source-val12'))
  wrong.checkpoint.latest.resources[0].urn = 'urn:pulumi:other-stage::other-app::pulumi:pulumi:Stack::evil'
  assert.throws(() => assertSstStateCheckpoint(JSON.stringify(wrong), {
    app: 'stokd-agent-data', stage: 'source-val12', requireEmpty: true,
  }), /stack URN changed/)
})

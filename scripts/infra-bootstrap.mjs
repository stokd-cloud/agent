#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseCallerIdentity } from '../infra/shared/identity.mjs'
import { ensureEmptySstHomeStates } from './infra-initialize-sst-home.mjs'
import {
  SST_BOOTSTRAP_PARAMETER,
  assertSstAssetEcr,
  assertSstStateBucketControls,
  assertSstStateBucketOwnership,
  assertSstStateBucketPolicy,
  assertSstStateLifecycle,
  assertUsEast1BucketLocation,
  parseSstBootstrapParameter,
} from './infra-sst-bootstrap.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const template = resolve(root, 'infra/bootstrap/template.yaml')
const emptyStateConfig = resolve(root, 'infra/bootstrap/empty-state.sst.config.ts')
const reviewedSources = [
  template,
  emptyStateConfig,
  resolve(root, 'package.json'),
  resolve(root, 'pnpm-lock.yaml'),
  fileURLToPath(import.meta.url),
  resolve(root, 'scripts/infra-initialize-sst-home.mjs'),
  resolve(root, 'scripts/infra-sst-bootstrap.mjs'),
  resolve(root, 'scripts/infra-github-environment.mjs'),
  resolve(root, 'infra/shared/identity.mjs'),
]
const githubOidcProviderArn = 'arn:aws:iam::167217327520:oidc-provider/token.actions.githubusercontent.com'

function reviewedSourceSha256() {
  const digest = createHash('sha256')
  for (const path of reviewedSources) digest.update(`${path.slice(root.length + 1)}\0`).update(readFileSync(path)).update('\0')
  return digest.digest('hex')
}

function reviewedRuntime(sstRuntime) {
  return {
    reviewedSourceSha256: reviewedSourceSha256(),
    emptyConfigSha256: sha256File(emptyStateConfig),
    initializerSha256: sha256File(resolve(root, 'scripts/infra-initialize-sst-home.mjs')),
    sstVersion: sstRuntime.sstVersion,
    pulumiVersion: sstRuntime.pulumiVersion,
    sstPackageSha256: sstRuntime.sstPackageSha256,
    sstLauncherSha256: sstRuntime.sstLauncherSha256,
    sstNativePackageSha256: sstRuntime.sstNativePackageSha256,
    sstBinarySha256: sstRuntime.sstBinarySha256,
  }
}

function bootstrapAcknowledgement(reviewed) {
  const runtimeSha256 = createHash('sha256').update(JSON.stringify(reviewed)).digest('hex')
  return `agent-bootstrap/v2/167217327520/us-east-1/${reviewed.reviewedSourceSha256}/${runtimeSha256}`
}

function aws(args, environment, stdio = 'inherit') {
  const result = spawnSync('aws', args, { cwd: root, env: environment, encoding: stdio === 'pipe' ? 'utf8' : undefined, stdio })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`AWS bootstrap command failed with exit ${result.status}: ${String(result.stderr || result.stdout || '').trim()}`)
  return result.stdout
}

function putSecureParameter(payload, environment) {
  const result = spawnSync('aws', [
    'ssm', 'put-parameter', '--cli-input-json', 'file:///dev/stdin',
    '--output', 'json', '--region', 'us-east-1',
  ], {
    cwd: root,
    env: environment,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = String(result.stderr || result.stdout || '').replaceAll(payload.Value, '[redacted]').trim()
    throw new Error(`secure SSM parameter creation failed with exit ${result.status}: ${output}`)
  }
  return result.stdout
}

export function inspectExistingSstBootstrap(awsRead) {
  const bootstrap = parseSstBootstrapParameter(awsRead(['ssm', 'get-parameter', '--name', SST_BOOTSTRAP_PARAMETER, '--no-with-decryption', '--output', 'json', '--region', 'us-east-1']))
  assertUsEast1BucketLocation(awsRead(['s3api', 'get-bucket-location', '--bucket', bootstrap.state, '--expected-bucket-owner', '167217327520', '--output', 'json', '--region', 'us-east-1']), bootstrap.state)
  assertUsEast1BucketLocation(awsRead(['s3api', 'get-bucket-location', '--bucket', bootstrap.asset, '--expected-bucket-owner', '167217327520', '--output', 'json', '--region', 'us-east-1']), bootstrap.asset)
  bootstrap.stateControls = assertSstStateBucketControls({
    versioningRaw: awsRead(['s3api', 'get-bucket-versioning', '--bucket', bootstrap.state, '--expected-bucket-owner', '167217327520', '--output', 'json', '--region', 'us-east-1']),
    encryptionRaw: awsRead(['s3api', 'get-bucket-encryption', '--bucket', bootstrap.state, '--expected-bucket-owner', '167217327520', '--output', 'json', '--region', 'us-east-1']),
    publicAccessRaw: awsRead(['s3api', 'get-public-access-block', '--bucket', bootstrap.state, '--expected-bucket-owner', '167217327520', '--output', 'json', '--region', 'us-east-1']),
  })
  bootstrap.stateControls.ownership = assertSstStateBucketOwnership(awsRead([
    's3api', 'get-bucket-ownership-controls', '--bucket', bootstrap.state,
    '--expected-bucket-owner', '167217327520', '--output', 'json', '--region', 'us-east-1',
  ]))
  bootstrap.stateControls.policy = assertSstStateBucketPolicy(awsRead([
    's3api', 'get-bucket-policy', '--bucket', bootstrap.state,
    '--expected-bucket-owner', '167217327520', '--output', 'json', '--region', 'us-east-1',
  ]), bootstrap.state)
  let lifecycleRaw
  try {
    lifecycleRaw = awsRead([
      's3api', 'get-bucket-lifecycle-configuration', '--bucket', bootstrap.state,
      '--expected-bucket-owner', '167217327520', '--output', 'json', '--region', 'us-east-1',
    ])
  } catch (error) {
    if (!/NoSuchLifecycleConfiguration/.test(error instanceof Error ? error.message : String(error))) throw error
    lifecycleRaw = JSON.stringify({ Rules: [] })
  }
  bootstrap.stateControls.lifecycle = assertSstStateLifecycle(lifecycleRaw)
  bootstrap.assetEcr = assertSstAssetEcr(awsRead(['ecr', 'describe-repositories', '--registry-id', bootstrap.assetEcrRegistryId, '--repository-names', 'sst-asset', '--output', 'json', '--region', 'us-east-1']), bootstrap)
  return bootstrap
}

function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }

function sanitizedSstEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => (
    !name.startsWith('SST_')
    && !name.startsWith('PULUMI_')
    && !['AGENT_EMPTY_SST_APP', 'AGENT_SST_INIT_RESUME_TOKEN', 'AGENT_BOOTSTRAP_ACK'].includes(name)
  )))
}

export function inspectSstRuntime(environment = process.env, spawn = spawnSync) {
  const nativeName = `sst-${process.platform}-${process.arch}`
  const nativeBinaryName = process.platform === 'win32' ? 'sst.exe' : 'sst'
  const packageRoot = realpathSync(resolve(root, 'node_modules/sst'))
  const packagePath = resolve(packageRoot, 'package.json')
  const launcherPath = resolve(packageRoot, 'bin/sst.mjs')
  const requireFromSst = createRequire(pathToFileURL(launcherPath))
  const nativeBinaryPath = requireFromSst.resolve(`${nativeName}/bin/${nativeBinaryName}`)
  const nativePackagePath = requireFromSst.resolve(`${nativeName}/package.json`)
  const packageValue = JSON.parse(readFileSync(packagePath, 'utf8'))
  const nativePackageValue = JSON.parse(readFileSync(nativePackagePath, 'utf8'))
  if (packageValue.name !== 'sst' || packageValue.version !== '3.19.3') throw new Error('installed SST package is not the reviewed 3.19.3 release')
  if (nativePackageValue.name !== nativeName || nativePackageValue.version !== '3.19.3') throw new Error('installed SST native package is not the reviewed 3.19.3 platform release')
  const cli = nativeBinaryPath
  const version = spawn(cli, ['version'], {
    cwd: root, env: sanitizedSstEnvironment(environment), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (version.error) throw version.error
  if (version.status !== 0 || version.stdout.trim() !== 'sst 3.19.3') throw new Error(`installed SST executable identity changed: ${(version.stderr || version.stdout).trim()}`)
  return {
    cli, sstVersion: '3.19.3', pulumiVersion: '3.210.0',
    sstPackageSha256: sha256File(packagePath), sstLauncherSha256: sha256File(launcherPath),
    sstNativePackageSha256: sha256File(nativePackagePath), sstBinarySha256: sha256File(nativeBinaryPath),
  }
}

export function run(argv = process.argv.slice(2), environment = process.env) {
  if (argv[0] === 'resume-token' && argv.length === 1) {
    process.stdout.write(`${randomBytes(32).toString('base64url')}\n`)
    return 0
  }
  if (argv[0] === 'acknowledge' && argv.length === 1) {
    const reviewed = reviewedRuntime(inspectSstRuntime(environment))
    process.stdout.write(`${bootstrapAcknowledgement(reviewed)}\n`)
    return 0
  }
  if (argv[0] !== 'apply') throw new Error('usage: infra-bootstrap.mjs acknowledge | resume-token | AGENT_SST_INIT_RESUME_TOKEN=<pre-generated-token> infra-bootstrap.mjs apply --ack <value> [--oidc-provider-arn <exact-arn>]')
  const resumeToken = environment.AGENT_SST_INIT_RESUME_TOKEN
  if (!/^[A-Za-z0-9_-]{43}$/.test(resumeToken ?? '')) throw new Error('AGENT_SST_INIT_RESUME_TOKEN must be generated and stored before bootstrap apply')
  const { AGENT_SST_INIT_RESUME_TOKEN: _resumeToken, ...commandEnvironment } = environment
  const sstRuntime = inspectSstRuntime(commandEnvironment)
  const reviewed = reviewedRuntime(sstRuntime)
  const acknowledgement = bootstrapAcknowledgement(reviewed)
  const ackIndexes = argv.flatMap((value, index) => value === '--ack' ? [index] : [])
  if (ackIndexes.length !== 1 || argv[ackIndexes[0] + 1] !== acknowledgement || environment.AGENT_BOOTSTRAP_ACK !== acknowledgement) {
    throw new Error('bootstrap refused: --ack and AGENT_BOOTSTRAP_ACK must match the reviewed source and SST executable digest')
  }
  const oidcIndexes = argv.flatMap((value, index) => value === '--oidc-provider-arn' ? [index] : [])
  if (oidcIndexes.length > 1) throw new Error('--oidc-provider-arn may be provided at most once')
  const consumed = new Set([0, ackIndexes[0], ackIndexes[0] + 1, ...(oidcIndexes.length ? [oidcIndexes[0], oidcIndexes[0] + 1] : [])])
  if (argv.some((_, index) => !consumed.has(index))) throw new Error('bootstrap received an unrecognized argument')
  const assertReviewedInputsUnchanged = () => {
    const current = reviewedRuntime(inspectSstRuntime(commandEnvironment))
    if (JSON.stringify(current) !== JSON.stringify(reviewed)) throw new Error('bootstrap refused: a reviewed source or SST runtime file changed after acknowledgement')
  }
  const identity = parseCallerIdentity(aws(['sts', 'get-caller-identity', '--output', 'json', '--region', 'us-east-1'], commandEnvironment, 'pipe'))
  if (identity.account !== '167217327520') throw new Error('bootstrap account mismatch')
  if (identity.arn === 'arn:aws:iam::167217327520:root' || identity.arn.endsWith(':root')) throw new Error('AWS account root is forbidden for Agent bootstrap')
  const region = commandEnvironment.AWS_REGION || commandEnvironment.AWS_DEFAULT_REGION
  if (region !== 'us-east-1') throw new Error('bootstrap region must be us-east-1')
  const providerArn = oidcIndexes.length ? argv[oidcIndexes[0] + 1] : githubOidcProviderArn
  if (providerArn !== githubOidcProviderArn) throw new Error('bootstrap GitHub OIDC provider ARN does not match the existing account provider')
  const sstBootstrap = inspectExistingSstBootstrap(args => aws(args, commandEnvironment, 'pipe'))
  const githubEnvironment = spawnSync(process.execPath, [resolve(root, 'scripts/infra-github-environment.mjs'), 'verify'], {
    cwd: root, env: commandEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (githubEnvironment.status !== 0) throw new Error(`bootstrap refused: GitHub environment readback failed: ${(githubEnvironment.stderr || githubEnvironment.stdout).trim()}`)
  const initializerAws = args => {
    if (args[0] === 's3api' && ['put-object', 'delete-object'].includes(args[1])) assertReviewedInputsUnchanged()
    return aws([...args, '--region', 'us-east-1'], commandEnvironment, 'pipe')
  }
  ensureEmptySstHomeStates({
    aws: initializerAws,
    putSecureParameter: payload => {
      assertReviewedInputsUnchanged()
      return putSecureParameter(payload, commandEnvironment)
    },
    bootstrap: sstBootstrap,
    reviewed,
    resumeToken,
    runEmptyDeploy: ({ app, stage }) => {
      assertReviewedInputsUnchanged()
      const result = spawnSync(sstRuntime.cli, ['deploy', '--config', emptyStateConfig, '--stage', stage], {
        cwd: root,
        env: { ...sanitizedSstEnvironment(commandEnvironment), SST_TELEMETRY_DISABLED: '1', AGENT_EMPTY_SST_APP: app, AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' },
        stdio: 'inherit',
      })
      if (result.error) throw result.error
      assertReviewedInputsUnchanged()
      return result.status ?? 1
    },
  })
  assertReviewedInputsUnchanged()
  const unchangedSstBootstrap = inspectExistingSstBootstrap(args => aws(args, commandEnvironment, 'pipe'))
  if (unchangedSstBootstrap.parameterVersion !== sstBootstrap.parameterVersion || unchangedSstBootstrap.sha256 !== sstBootstrap.sha256) {
    throw new Error('/sst/bootstrap value or parameter version changed during empty-state initialization')
  }
  assertReviewedInputsUnchanged()
  aws([
    'cloudformation', 'deploy', '--region', 'us-east-1',
    '--stack-name', 'stokd-agent-bootstrap',
    '--template-file', template,
    '--capabilities', 'CAPABILITY_NAMED_IAM',
    '--no-fail-on-empty-changeset',
    '--parameter-overrides',
    `ExistingGitHubOidcProviderArn=${githubOidcProviderArn}`,
    `ExistingSstBootstrapVersion=${sstBootstrap.version}`,
    `ExistingSstBootstrapSha256=${sstBootstrap.sha256}`,
    `ExistingSstStateBucketName=${sstBootstrap.state}`,
    `ExistingSstAssetBucketName=${sstBootstrap.asset}`,
    `ExistingSstAssetEcrRegistryId=${sstBootstrap.assetEcrRegistryId}`,
    `ExistingSstAssetEcrUrl=${sstBootstrap.assetEcrUrl}`,
    '--tags', 'Project=stokd-agent', 'Custody=bootstrap',
  ], commandEnvironment)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run() }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2 }
}

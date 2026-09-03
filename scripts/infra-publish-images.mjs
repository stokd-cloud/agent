#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { assertBoundedDeploymentIdentity, parseCallerIdentity } from '../infra/shared/identity.mjs'
import { SST_BOOTSTRAP_PARAMETER, parseSstBootstrapParameter } from './infra-sst-bootstrap.mjs'
import { inspectCompletedSstInitialization } from './infra-initialize-sst-home.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, env: process.env, encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${program} ${args[0] ?? ''} failed: ${(result.stderr || result.stdout || '').trim()}`)
  return (result.stdout ?? '').trim()
}

function writeEnvironment(name, value) {
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`, { encoding: 'utf8' })
}

export function expectedImageProvenance({ component, dockerfile, dockerfileDigest, sourceDigest, sourceTree, stage }) {
  return {
    'io.stokd.agent.component': component,
    'io.stokd.agent.context-tree': sourceTree,
    'io.stokd.agent.dockerfile': dockerfile,
    'io.stokd.agent.dockerfile-sha256': dockerfileDigest,
    'io.stokd.agent.stage': stage,
    'org.opencontainers.image.revision': sourceDigest,
    'org.opencontainers.image.source': 'https://github.com/stokd-cloud/agent',
  }
}

export function assertImageProvenance(actual, expected, component) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) throw new Error(`existing ${component} image omitted OCI provenance labels`)
  for (const [name, value] of Object.entries(expected)) {
    if (actual[name] !== value) throw new Error(`immutable ${component} image provenance mismatch for ${name}`)
  }
}

function describeExistingImage(tag) {
  const result = spawnSync('aws', [
    'ecr', 'describe-images', '--repository-name', 'stokd-agent-runtime', '--image-ids', `imageTag=${tag}`,
    '--region', 'us-east-1', '--output', 'json',
  ], { cwd: root, env: process.env, encoding: 'utf8' })
  if (result.status !== 0) {
    const diagnostic = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
    if (/ImageNotFoundException|image[^\n]*does not exist/i.test(diagnostic)) return undefined
    throw new Error(`unable to inspect immutable ECR tag ${tag}: ${diagnostic.trim()}`)
  }
  const detail = JSON.parse(result.stdout).imageDetails?.[0]
  if (!detail) return undefined
  if (!/^sha256:[0-9a-f]{64}$/.test(detail.imageDigest ?? '')) throw new Error(`ECR returned an invalid digest for ${tag}`)
  return detail.imageDigest
}

function inspectImageLabels(image) {
  const raw = command('docker', ['buildx', 'imagetools', 'inspect', image, '--format', '{{json .Image.Config.Labels}}'])
  try { return JSON.parse(raw) }
  catch { throw new Error(`unable to read OCI provenance labels for ${image}`) }
}

export function run(argv = process.argv.slice(2)) {
  const [stage, ...extra] = argv
  if (extra.length || !['source-val12', 'restore-val12'].includes(stage)) throw new Error('exactly one source-val12 or restore-val12 stage is required')
  const identity = parseCallerIdentity(command('aws', ['sts', 'get-caller-identity', '--output', 'json', '--region', 'us-east-1']))
  assertBoundedDeploymentIdentity(identity, process.env)
  const awsRead = args => command('aws', [...args, '--region', 'us-east-1'])
  const sstBootstrap = parseSstBootstrapParameter(awsRead(['ssm', 'get-parameter', '--name', SST_BOOTSTRAP_PARAMETER, '--no-with-decryption', '--output', 'json']))
  inspectCompletedSstInitialization({ aws: awsRead, bootstrap: sstBootstrap })
  const repositoryUri = JSON.parse(command('aws', ['ecr', 'describe-repositories', '--repository-names', 'stokd-agent-runtime', '--region', 'us-east-1', '--output', 'json'])).repositories?.[0]?.repositoryUri
  if (typeof repositoryUri !== 'string') throw new Error('stokd-agent-runtime ECR repository is missing')
  const password = command('aws', ['ecr', 'get-login-password', '--region', 'us-east-1'])
  command('docker', ['login', '--username', 'AWS', '--password-stdin', repositoryUri.split('/')[0]], { input: `${password}\n` })
  const sourceDigest = process.env.GITHUB_SHA || command('git', ['rev-parse', 'HEAD'])
  if (!/^[0-9a-f]{40}$/.test(sourceDigest)) throw new Error('source digest must be a full git SHA')
  const head = command('git', ['rev-parse', 'HEAD'])
  if (sourceDigest !== head) throw new Error('source digest must identify the checked-out commit')
  if (command('git', ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('immutable images require a clean checked-out source tree')
  const sourceTree = command('git', ['rev-parse', 'HEAD^{tree}'])
  if (!/^[0-9a-f]{40}$/.test(sourceTree)) throw new Error('source tree digest is invalid')
  const definitions = [
    ['AGENT_API_IMAGE', 'api', 'infra/docker/api.Dockerfile'],
    ['AGENT_MONGO_IMAGE', 'mongodb', 'infra/docker/mongodb.Dockerfile'],
    ['AGENT_MAINTENANCE_IMAGE', 'maintenance', 'infra/docker/maintenance.Dockerfile'],
  ]
  const outputs = { schemaVersion: '1.0', stage, sourceDigest, images: {} }
  for (const [environmentName, name, dockerfile] of definitions) {
    const tagName = `${name}-${stage}-${sourceDigest}`
    const tag = `${repositoryUri}:${tagName}`
    const dockerfileDigest = createHash('sha256').update(readFileSync(resolve(root, dockerfile))).digest('hex')
    const provenance = expectedImageProvenance({ component: name, dockerfile, dockerfileDigest, sourceDigest, sourceTree, stage })
    let digest = describeExistingImage(tagName)
    if (digest) {
      assertImageProvenance(inspectImageLabels(`${repositoryUri}@${digest}`), provenance, name)
    } else {
      const labels = Object.entries(provenance).flatMap(([key, value]) => ['--label', `${key}=${value}`])
      try {
        command('docker', ['buildx', 'build', '--platform', 'linux/amd64', '--file', dockerfile, '--tag', tag, ...labels, '--provenance=true', '--sbom=true', '--push', '.'], { stdio: 'inherit', encoding: undefined })
      } catch (error) {
        digest = describeExistingImage(tagName)
        if (!digest) throw error
      }
      digest ??= describeExistingImage(tagName)
      if (!digest) throw new Error(`ECR omitted immutable digest for ${name}`)
      assertImageProvenance(inspectImageLabels(`${repositoryUri}@${digest}`), provenance, name)
    }
    const image = `${repositoryUri}@${digest}`
    writeEnvironment(environmentName, image)
    outputs.images[name] = image
  }
  writeEnvironment('AGENT_SOURCE_DIGEST', sourceDigest)
  process.stdout.write(`${JSON.stringify(outputs)}\n`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run() }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2 }
}

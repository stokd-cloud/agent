#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runTerraform } from './infra-terraform.mjs'
import { assertBoundedDeploymentIdentity, parseCallerIdentity } from '../infra/shared/identity.mjs'
import { readRestoreLock } from './infra-restore-lock.mjs'
import {
  SST_BOOTSTRAP_PARAMETER,
  SST_HOME_IDENTITIES,
  SST_INIT_PREFIX,
  SST_INIT_TERMINAL_KEY,
  parseSstBootstrapParameter,
  sstInitTerminalKey,
} from './infra-sst-bootstrap.mjs'
import { ensureSstUnlockSentinel, inspectCompletedSstInitialization } from './infra-initialize-sst-home.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const persistentManifestPath = resolve(root, 'infra/persistent-resources.json')

export function parsePhysicalResourceManifest(manifestRaw, stage) {
  const manifest = JSON.parse(manifestRaw)
  if (manifest.schemaVersion !== '1.0' || manifest.accountId !== '167217327520' || manifest.region !== 'us-east-1' || manifest.stage !== stage) {
    throw new Error('physical resource manifest identity does not match the requested stage')
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.sourceDigest ?? '') || !/^[0-9a-f]{64}$/.test(manifest.planDigest ?? '')) {
    throw new Error('physical resource manifest requires sourceDigest and planDigest')
  }
  if (!Array.isArray(manifest.physicalResources) || manifest.physicalResources.length < 4 || !manifest.physicalResources.every((item) => typeof item?.type === 'string' && typeof item?.id === 'string' && item.id.length > 3)) {
    throw new Error('physical resource manifest requires actual physical resource IDs')
  }
  if (!manifest.custodyManifest || typeof manifest.custodyManifest.artifactBucket !== 'string' || typeof manifest.custodyManifest.backupBucket !== 'string' || typeof manifest.custodyManifest.databaseVolumeId !== 'string') {
    throw new Error('physical resource manifest requires artifact, backup, and database custody')
  }
  return manifest
}

export function destructionAcknowledgement(stage, physicalManifestRaw) {
  if (typeof physicalManifestRaw !== 'string') throw new Error('a post-deploy physical resource manifest is required')
  const manifest = parsePhysicalResourceManifest(physicalManifestRaw, stage)
  const resources = [...manifest.physicalResources].map(({ type, id }) => ({ type, id })).sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`))
  const canonical = JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    accountId: manifest.accountId,
    region: manifest.region,
    stage,
    sourceDigest: manifest.sourceDigest,
    planDigest: manifest.planDigest,
    resources,
    custodyManifest: manifest.custodyManifest,
  })
  return `agent-destroy/v1/${stage}/${createHash('sha256').update(canonical).digest('hex')}`
}

export function parseInfraArguments(argv) {
  const [app, action, ...rest] = argv
  if (!['data', 'api'].includes(app)) throw new Error('app must be data or api')
  if (!['diff', 'deploy', 'remove'].includes(action)) throw new Error('action must be diff, deploy, or remove')
  const stageFlags = rest.filter((value) => value === '--stage')
  const acknowledgementFlags = rest.filter((value) => value === '--destructive-ack')
  if (stageFlags.length !== 1) throw new Error('exactly one --stage is required')
  if (acknowledgementFlags.length > 1) throw new Error('--destructive-ack may be provided at most once')
  const stageIndex = rest.indexOf('--stage')
  if (!rest[stageIndex + 1]) throw new Error('--stage requires a value')
  const stage = rest[stageIndex + 1]
  if (!['source-val12', 'restore-val12'].includes(stage)) throw new Error(`unsupported Agent validation stage: ${stage}`)
  const ackIndex = rest.indexOf('--destructive-ack')
  const destructiveAck = ackIndex >= 0 ? rest[ackIndex + 1] : undefined
  if (ackIndex >= 0 && !destructiveAck) throw new Error('--destructive-ack requires a value')
  const consumed = new Set([stageIndex, stageIndex + 1, ...(ackIndex >= 0 ? [ackIndex, ackIndex + 1] : [])])
  const unrecognized = rest.filter((_, index) => !consumed.has(index))
  if (unrecognized.length > 0) throw new Error(`unrecognized infrastructure arguments: ${unrecognized.join(' ')}`)
  return { app, action, stage, destructiveAck }
}

function readAwsIdentity(environment) {
  const result = spawnSync('aws', ['sts', 'get-caller-identity', '--output', 'json', '--region', 'us-east-1'], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) throw new Error(`unable to verify AWS caller identity: ${(result.stderr || result.stdout).trim()}`)
  return parseCallerIdentity(result.stdout)
}

function aws(environment, args) {
  const result = spawnSync('aws', [...args, '--region', 'us-east-1'], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`unable to read restore admission control: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout
}

export function assertInfraMutationUnlocked(input, awsRead) {
  if (!['deploy', 'remove'].includes(input.action)) return
  const lock = readRestoreLock(awsRead)
  if (lock) throw new Error(`${input.action} refused: restore admission lock ${lock.operationId} is active for ${lock.validationRunId}`)
}

export function assertSstInitializationInactive(awsRead) {
  const bootstrap = parseSstBootstrapParameter(awsRead(['ssm', 'get-parameter', '--name', SST_BOOTSTRAP_PARAMETER, '--no-with-decryption', '--output', 'json']))
  const envelope = JSON.parse(awsRead([
    's3api', 'list-objects-v2', '--bucket', bootstrap.state, '--prefix', SST_INIT_PREFIX,
    '--expected-bucket-owner', '167217327520', '--output', 'json',
  ]))
  if (envelope.IsTruncated === true) throw new Error('SST initialization guard refused a truncated active-marker readback')
  const contents = envelope.Contents ?? []
  if (!Array.isArray(contents) || (envelope.KeyCount !== undefined && envelope.KeyCount !== contents.length)) throw new Error('SST initialization guard returned an invalid listing')
  for (const object of contents) {
    if (typeof object?.Key !== 'string' || !object.Key.startsWith(SST_INIT_PREFIX)) throw new Error('SST initialization guard escaped its exact prefix')
  }
  const active = contents.filter(object => object.Key.endsWith('/active.json'))
  if (active.length) throw new Error(`infrastructure action refused: ${active.length} SST home initialization marker(s) are active`)
  const currentKeys = new Set(contents.map(object => object.Key))
  const requiredTerminalKeys = [
    SST_INIT_TERMINAL_KEY,
    ...SST_HOME_IDENTITIES.map(({ app, stage }) => sstInitTerminalKey(app, stage)),
  ]
  const missing = requiredTerminalKeys.filter(key => !currentKeys.has(key))
  if (missing.length) throw new Error(`infrastructure action refused: SST home initialization terminal receipt(s) are missing: ${missing.join(', ')}`)
  return bootstrap
}

export function validateInfraAction(input, identity, environment = process.env) {
  assertBoundedDeploymentIdentity(identity, environment)
  if (input.action === 'remove') {
    if (!environment.AGENT_PHYSICAL_RESOURCE_MANIFEST) throw new Error('remove refused: AGENT_PHYSICAL_RESOURCE_MANIFEST is required')
    const physicalManifestRaw = readFileSync(resolve(environment.AGENT_PHYSICAL_RESOURCE_MANIFEST), 'utf8')
    const expected = destructionAcknowledgement(input.stage, physicalManifestRaw)
    if (input.destructiveAck !== expected || environment.AGENT_DESTRUCTIVE_ACK !== expected) {
      throw new Error('remove refused: the CLI and AGENT_DESTRUCTIVE_ACK must both match the resource-bound acknowledgement')
    }
  }
}

export function run(argv = process.argv.slice(2), environment = process.env) {
  const input = parseInfraArguments(argv)
  const identity = readAwsIdentity(environment)
  validateInfraAction(input, identity, environment)
  const awsRead = args => aws(environment, args)
  const bootstrap = assertSstInitializationInactive(awsRead)
  const initialization = inspectCompletedSstInitialization({ aws: awsRead, bootstrap })
  assertInfraMutationUnlocked(input, awsRead)
  const app = `stokd-agent-${input.app}`
  ensureSstUnlockSentinel({ aws: awsRead, bootstrap, app, stage: input.stage, bindingSha256: initialization.bindingSha256 })
  // Terraform is the durable IaC substrate (AX-CLOUD-TERRAFORM). The SST
  // configs under infra/api and infra/data remain in the tree as historical
  // scaffold and are never executed. Both former apps map onto the single root
  // module; apply is idempotent, so the pipeline's data-then-api phase order is
  // preserved without either phase being skipped.
  let status
  try {
    status = runTerraform({ ...input, root }, environment)
  } finally {
    ensureSstUnlockSentinel({ aws: awsRead, bootstrap, app, stage: input.stage, bindingSha256: initialization.bindingSha256 })
  }
  return status ?? 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export const restoreLockParameterName = '/stokd-agent/validation/work-1.2/restore-admission-lock/v1'

function parse(raw, label) {
  try { return JSON.parse(raw) }
  catch { throw new Error(`${label} returned invalid JSON`) }
}
function exactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields changed`)
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
  return value
}
function bindingValue(value) {
  const { createdAt: _createdAt, ...binding } = value
  return canonical(binding)
}

export function assertRestoreLock(value) {
  exactKeys(value, ['schemaVersion', 'kind', 'status', 'validationRunId', 'sourceDigest', 'planDigest', 'phase', 'stage', 'operationId', 'inputBindingSha256', 'sourceResourceIds', 'targetResourceIds', 'createdAt'], 'restore admission lock')
  assert.equal(value.schemaVersion, '1.0')
  assert.equal(value.kind, 'work-1.2-restore-admission-lock')
  assert.equal(value.status, 'active')
  assert.match(value.validationRunId, /^github-[1-9][0-9]{0,19}$/)
  assert.match(value.sourceDigest, /^[a-f0-9]{40}$/)
  assert.match(value.planDigest, /^[a-f0-9]{64}$/)
  assert.equal(value.phase, 'restore-api-proof')
  assert.equal(value.stage, 'restore-val12')
  assert.match(value.operationId, /^work12-[a-f0-9]{32}$/)
  assert.match(value.inputBindingSha256, /^[a-f0-9]{64}$/)
  for (const [name, resources] of [['source', value.sourceResourceIds], ['target', value.targetResourceIds]]) {
    exactKeys(resources, ['artifactBucket', 'backupBucket', 'databaseVolumeId', 'kmsKeyArn', 'mongoInstanceId'], `${name} restore resources`)
  }
  assert.equal(new Date(value.createdAt).toISOString(), value.createdAt)
  return value
}

export function buildRestoreLockBinding({ validationRunId, sourceDigest, planDigest, operationId, sourceResourceIds, targetResourceIds, selectedBackup }) {
  const inputBindingSha256 = createHash('sha256').update(JSON.stringify(canonical({ operationId, sourceResourceIds, targetResourceIds, selectedBackup }))).digest('hex')
  return {
    schemaVersion: '1.0', kind: 'work-1.2-restore-admission-lock', status: 'active', validationRunId, sourceDigest, planDigest,
    phase: 'restore-api-proof', stage: 'restore-val12', operationId, inputBindingSha256,
    sourceResourceIds: canonical(sourceResourceIds), targetResourceIds: canonical(targetResourceIds),
  }
}

export function readRestoreLock(aws) {
  try {
    const envelope = parse(aws(['ssm', 'get-parameter', '--name', restoreLockParameterName, '--output', 'json']), 'restore admission lock')
    if (typeof envelope?.Parameter?.Value !== 'string') throw new Error('restore admission lock omitted its value')
    return assertRestoreLock(parse(envelope.Parameter.Value, 'restore admission lock value'))
  } catch (error) {
    if (/ParameterNotFound/.test(error instanceof Error ? error.message : String(error))) return undefined
    throw error
  }
}

export function createOrResumeRestoreLock({ aws, binding, now = () => new Date() }) {
  assertRestoreLock({ ...binding, createdAt: now().toISOString() })
  const existing = readRestoreLock(aws)
  if (existing) {
    assert.deepEqual(bindingValue(existing), canonical(binding), 'a different restore admission lock owns the validation stage')
    return { lock: existing, resumed: true }
  }
  const candidate = assertRestoreLock({ ...binding, createdAt: now().toISOString() })
  let created = true
  try {
    aws(['ssm', 'put-parameter', '--name', restoreLockParameterName, '--type', 'String', '--data-type', 'text', '--value', JSON.stringify(candidate), '--output', 'json'])
    aws(['ssm', 'add-tags-to-resource', '--resource-type', 'Parameter', '--resource-id', restoreLockParameterName, '--tags', 'Key=Project,Value=stokd-agent', 'Key=Stage,Value=restore-val12', 'Key=Custody,Value=restore-admission-lock'])
  } catch (error) {
    if (!/ParameterAlreadyExists/.test(error instanceof Error ? error.message : String(error))) throw error
    created = false
  }
  const observed = readRestoreLock(aws)
  if (!observed) throw new Error('restore admission lock disappeared after create')
  assert.deepEqual(bindingValue(observed), canonical(binding), 'restore admission lock changed during create')
  return { lock: observed, resumed: !created }
}

export function releaseRestoreLock({ aws, expected }) {
  const existing = readRestoreLock(aws)
  if (!existing) throw new Error('restore admission lock disappeared before verified completion')
  assert.deepEqual(bindingValue(existing), canonical(expected), 'restore admission lock changed before verified completion')
  aws(['ssm', 'delete-parameter', '--name', restoreLockParameterName, '--output', 'json'])
  if (readRestoreLock(aws)) throw new Error('restore admission lock remained after verified completion')
}

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { evidenceParameterName, readVersionedEvidence, writeVersionedEvidence } from './infra-evidence.mjs'
import { readRestoreLock } from './infra-restore-lock.mjs'

export const work12Phases = [
  { phase: 'source-data', stage: 'source-val12', component: 'data', scenario: 'migrate' },
  { phase: 'source-api-proof', stage: 'source-val12', component: 'api', scenario: 'source-proof' },
  { phase: 'restore-data', stage: 'restore-val12', component: 'data', scenario: 'migrate' },
  { phase: 'restore-api-proof', stage: 'restore-val12', component: 'api', scenario: 'restore-proof' },
  { phase: 'source-data-redeploy', stage: 'source-val12', component: 'data', scenario: 'migrate-and-redeploy-proof' },
  { phase: 'source-api-redeploy', stage: 'source-val12', component: 'api', scenario: 'redeploy-proof' },
  { phase: 'restore-data-redeploy', stage: 'restore-val12', component: 'data', scenario: 'migrate-and-redeploy-proof' },
  { phase: 'restore-api-redeploy', stage: 'restore-val12', component: 'api', scenario: 'redeploy-proof' },
]

function exactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields changed`)
}
function parse(raw, label) {
  try { return JSON.parse(raw) }
  catch { throw new Error(`${label} returned invalid JSON`) }
}
function identity(phase) {
  const index = work12Phases.findIndex(value => value.phase === phase)
  if (index < 0) throw new Error('Work 1.2 phase is invalid')
  return { ...work12Phases[index], index, predecessor: index === 0 ? undefined : work12Phases[index - 1] }
}
function assertRun(validationRunId, sourceDigest) {
  assert.match(validationRunId ?? '', /^github-[1-9][0-9]{0,19}$/)
  assert.match(sourceDigest ?? '', /^[a-f0-9]{40}$/)
}
export function validationChainId(validationRunId, sourceDigest) {
  assertRun(validationRunId, sourceDigest)
  return createHash('sha256').update(`work-1.2\0${validationRunId}\0${sourceDigest}`).digest('hex')
}
export function phaseEvidenceKind(phase) { identity(phase); return `phase-${phase}` }
export function phasePlanParameterName(validationRunId, phase) {
  assert.match(validationRunId ?? '', /^github-[1-9][0-9]{0,19}$/)
  identity(phase)
  return `/stokd-agent/validation/work-1.2/runs/${validationRunId}/phases/${phase}/plan/v1`
}

function assertPhasePlan(value, expected, predecessorPointer) {
  exactKeys(value, ['schemaVersion', 'kind', 'validationRunId', 'chainId', 'sourceDigest', 'phase', 'phaseIndex', 'stage', 'component', 'scenario', 'planDigest', 'predecessor', 'boundAt'], 'phase plan binding')
  assert.equal(value.schemaVersion, '1.0')
  assert.equal(value.kind, 'work-1.2-phase-plan-binding')
  assert.equal(value.validationRunId, expected.validationRunId)
  assert.equal(value.chainId, validationChainId(expected.validationRunId, expected.sourceDigest))
  assert.equal(value.sourceDigest, expected.sourceDigest)
  assert.equal(value.phase, expected.phase)
  assert.equal(value.phaseIndex, expected.index + 1)
  assert.equal(value.stage, expected.stage)
  assert.equal(value.component, expected.component)
  assert.equal(value.scenario, expected.scenario)
  assert.match(value.planDigest, /^[a-f0-9]{64}$/)
  assert.equal(new Date(value.boundAt).toISOString(), value.boundAt)
  if (expected.index === 0) assert.equal(value.predecessor, null)
  else {
    exactKeys(value.predecessor, ['phase', 'stage', 'versionId', 'sha256'], 'phase plan predecessor')
    assert.equal(value.predecessor.phase, expected.predecessor.phase)
    assert.equal(value.predecessor.stage, expected.predecessor.stage)
    assert.equal(value.predecessor.versionId, predecessorPointer.versionId)
    assert.equal(value.predecessor.sha256, predecessorPointer.sha256)
  }
  return value
}

function optionalPhasePlan(aws, phaseIdentity, validationRunId, sourceDigest, predecessorPointer) {
  const name = phasePlanParameterName(validationRunId, phaseIdentity.phase)
  try {
    const envelope = parse(aws(['ssm', 'get-parameter', '--name', name, '--output', 'json']), `${phaseIdentity.phase} plan binding`)
    if (typeof envelope.Parameter?.Value !== 'string') throw new Error(`${phaseIdentity.phase} plan binding omitted its value`)
    return assertPhasePlan(parse(envelope.Parameter.Value, `${phaseIdentity.phase} plan binding value`), { ...phaseIdentity, validationRunId, sourceDigest }, predecessorPointer)
  } catch (error) {
    if (/ParameterNotFound/.test(error instanceof Error ? error.message : String(error))) return undefined
    throw error
  }
}

export function readBoundPhasePlan({ aws, phase, validationRunId, sourceDigest, predecessorPointer }) {
  assertRun(validationRunId, sourceDigest)
  const phaseIdentity = identity(phase)
  const value = optionalPhasePlan(aws, phaseIdentity, validationRunId, sourceDigest, predecessorPointer)
  if (!value) throw new Error(`phase ${phase} has no durable plan binding`)
  return value
}

function bindPhasePlan({ aws, phaseIdentity, validationRunId, sourceDigest, planDigest, predecessorPointer, now = new Date() }) {
  assert.match(planDigest ?? '', /^[a-f0-9]{64}$/)
  const current = optionalPhasePlan(aws, phaseIdentity, validationRunId, sourceDigest, predecessorPointer)
  if (current) {
    assert.equal(current.planDigest, planDigest, `${phaseIdentity.phase} plan digest changed after its durable binding`)
    return { value: current, created: false }
  }
  const value = assertPhasePlan({
    schemaVersion: '1.0', kind: 'work-1.2-phase-plan-binding', validationRunId,
    chainId: validationChainId(validationRunId, sourceDigest), sourceDigest,
    phase: phaseIdentity.phase, phaseIndex: phaseIdentity.index + 1, stage: phaseIdentity.stage,
    component: phaseIdentity.component, scenario: phaseIdentity.scenario, planDigest,
    predecessor: predecessorPointer ? { phase: phaseIdentity.predecessor.phase, stage: phaseIdentity.predecessor.stage, versionId: predecessorPointer.versionId, sha256: predecessorPointer.sha256 } : null,
    boundAt: now.toISOString(),
  }, { ...phaseIdentity, validationRunId, sourceDigest }, predecessorPointer)
  const name = phasePlanParameterName(validationRunId, phaseIdentity.phase)
  let created = true
  try {
    aws(['ssm', 'put-parameter', '--name', name, '--type', 'String', '--data-type', 'text', '--value', JSON.stringify(value), '--output', 'json'])
    aws(['ssm', 'add-tags-to-resource', '--resource-type', 'Parameter', '--resource-id', name, '--tags', 'Key=Project,Value=stokd-agent', `Key=Stage,Value=${phaseIdentity.stage}`, 'Key=Custody,Value=work-1.2-phase-plan'])
  } catch (error) {
    if (!/ParameterAlreadyExists/.test(error instanceof Error ? error.message : String(error))) throw error
    created = false
  }
  const observed = optionalPhasePlan(aws, phaseIdentity, validationRunId, sourceDigest, predecessorPointer)
  if (!observed) throw new Error(`${phaseIdentity.phase} plan binding disappeared after create`)
  assert.equal(observed.planDigest, planDigest, `${phaseIdentity.phase} plan binding changed during create`)
  return { value: observed, created }
}

function readManifest(aws, stage, optional = false) {
  const name = `/stokd-agent/${stage}/infrastructure-manifest/v1`
  try {
    const envelope = parse(aws(['ssm', 'get-parameter', '--name', name, '--output', 'json']), `${stage} manifest`)
    const manifest = parse(envelope.Parameter?.Value, `${stage} manifest value`)
    if (manifest.schemaVersion !== '1.0' || manifest.stage !== stage || !/^[a-f0-9]{40}$/.test(manifest.sourceDigest ?? '') || !/^arn:aws:kms:us-east-1:167217327520:key\/[a-f0-9-]{36}$/.test(manifest.custody?.kmsKeyArn ?? '')) throw new Error(`${stage} manifest identity is invalid`)
    return manifest
  } catch (error) {
    if (optional && /ParameterNotFound/.test(error instanceof Error ? error.message : String(error))) return undefined
    throw error
  }
}

function optionalPhaseEvidence(aws, phaseIdentity) {
  const manifest = readManifest(aws, phaseIdentity.stage, true)
  if (!manifest) return undefined
  const name = evidenceParameterName(phaseIdentity.stage, phaseEvidenceKind(phaseIdentity.phase))
  try {
    return readVersionedEvidence({ aws, stage: phaseIdentity.stage, kind: phaseEvidenceKind(phaseIdentity.phase), kmsKeyArn: manifest.custody.kmsKeyArn })
  } catch (error) {
    if (/ParameterNotFound/.test(error instanceof Error ? error.message : String(error))) return undefined
    throw new Error(`${name} could not be verified: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function assertPhaseReceipt(value, expected, predecessorPointer) {
  exactKeys(value, ['schemaVersion', 'kind', 'validationRunId', 'chainId', 'sourceDigest', 'phase', 'phaseIndex', 'stage', 'component', 'scenario', 'requestId', 'planDigest', 'predecessor', 'resultSha256', 'completedAt'], 'phase receipt')
  assert.equal(value.schemaVersion, '1.0')
  assert.equal(value.kind, 'work-1.2-phase-receipt')
  assert.equal(value.validationRunId, expected.validationRunId)
  assert.equal(value.chainId, validationChainId(expected.validationRunId, expected.sourceDigest))
  assert.equal(value.sourceDigest, expected.sourceDigest)
  assert.equal(value.phase, expected.phase)
  assert.equal(value.phaseIndex, expected.index + 1)
  assert.equal(value.stage, expected.stage)
  assert.equal(value.component, expected.component)
  assert.equal(value.scenario, expected.scenario)
  assert.equal(value.requestId, `${expected.validationRunId}-${expected.phase}`)
  if (expected.planDigest !== undefined) assert.equal(value.planDigest, expected.planDigest)
  assert.match(value.planDigest, /^[a-f0-9]{64}$/)
  assert.match(value.resultSha256, /^[a-f0-9]{64}$/)
  assert.equal(new Date(value.completedAt).toISOString(), value.completedAt)
  if (expected.index === 0) assert.equal(value.predecessor, null)
  else {
    exactKeys(value.predecessor, ['phase', 'stage', 'versionId', 'sha256'], 'phase predecessor')
    assert.equal(value.predecessor.phase, expected.predecessor.phase)
    assert.equal(value.predecessor.stage, expected.predecessor.stage)
    assert.equal(value.predecessor.versionId, predecessorPointer.versionId)
    assert.equal(value.predecessor.sha256, predecessorPointer.sha256)
  }
  return value
}

function assertHistoricalPhaseReceipt(value, phaseIdentity) {
  assert.match(value?.validationRunId ?? '', /^github-[1-9][0-9]{0,19}$/)
  assert.match(value?.sourceDigest ?? '', /^[a-f0-9]{40}$/)
  const predecessorPointer = phaseIdentity.index === 0 ? undefined : {
    versionId: value?.predecessor?.versionId,
    sha256: value?.predecessor?.sha256,
  }
  return assertPhaseReceipt(value, {
    ...phaseIdentity,
    validationRunId: value.validationRunId,
    sourceDigest: value.sourceDigest,
    planDigest: value.planDigest,
  }, predecessorPointer)
}

function validatedEvidence(aws, phaseIdentity, validationRunId, sourceDigest, cache = new Map()) {
  if (cache.has(phaseIdentity.phase)) return cache.get(phaseIdentity.phase)
  const predecessor = phaseIdentity.predecessor ? validatedEvidence(aws, identity(phaseIdentity.predecessor.phase), validationRunId, sourceDigest, cache) : undefined
  const evidence = optionalPhaseEvidence(aws, phaseIdentity)
  if (!evidence) throw new Error(`phase ${phaseIdentity.phase} is missing its immutable receipt`)
  assertPhaseReceipt(evidence.value, { ...phaseIdentity, validationRunId, sourceDigest }, predecessor?.pointer)
  cache.set(phaseIdentity.phase, evidence)
  return evidence
}

function predecessorEvidence(aws, phaseIdentity, validationRunId, sourceDigest) {
  if (!phaseIdentity.predecessor) return undefined
  try {
    return validatedEvidence(aws, identity(phaseIdentity.predecessor.phase), validationRunId, sourceDigest)
  } catch (error) {
    throw new Error(`phase ${phaseIdentity.phase} has an invalid predecessor chain: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function preflightPhase({ aws, phase, validationRunId, sourceDigest, planDigest }) {
  assertRun(validationRunId, sourceDigest)
  const phaseIdentity = identity(phase)
  const predecessor = predecessorEvidence(aws, phaseIdentity, validationRunId, sourceDigest)
  const current = optionalPhaseEvidence(aws, phaseIdentity)
  const lock = readRestoreLock(aws)
  const existingPlan = optionalPhasePlan(aws, phaseIdentity, validationRunId, sourceDigest, predecessor?.pointer)
  if (current) {
    const currentMatches = current.value?.validationRunId === validationRunId
    if (currentMatches) {
      if (!existingPlan) throw new Error(`phase ${phase} receipt has no durable plan binding`)
      assertPhaseReceipt(current.value, { ...phaseIdentity, validationRunId, sourceDigest, planDigest: existingPlan?.planDigest }, predecessor?.pointer)
    } else assertHistoricalPhaseReceipt(current.value, phaseIdentity)
    if (currentMatches) {
      if (lock) {
        if (phase === 'restore-api-proof' && lock.validationRunId === validationRunId && lock.sourceDigest === sourceDigest && existingPlan?.planDigest === lock.planDigest) {
          return { schemaVersion: '1.0', phase, stage: phaseIdentity.stage, component: phaseIdentity.component, scenario: phaseIdentity.scenario, replay: false, resume: true, restoreResume: true, planDigest: lock.planDigest }
        }
        throw new Error(`phase ${phase} is locked by active restore ${lock.operationId}`)
      }
      return { schemaVersion: '1.0', phase, stage: phaseIdentity.stage, component: phaseIdentity.component, scenario: phaseIdentity.scenario, replay: true, resume: false, restoreResume: false }
    }
    // A fully valid receipt from a different run may occupy the current
    // pointer. It is never accepted as completion for this run.
  }
  if (lock) {
    if (phase === 'restore-api-proof' && lock.validationRunId === validationRunId && lock.sourceDigest === sourceDigest && existingPlan?.planDigest === lock.planDigest) {
      return { schemaVersion: '1.0', phase, stage: phaseIdentity.stage, component: phaseIdentity.component, scenario: phaseIdentity.scenario, replay: false, resume: true, restoreResume: true, planDigest: lock.planDigest }
    }
    throw new Error(`phase ${phase} is locked by active restore ${lock.operationId}`)
  }
  if (planDigest !== undefined) {
    const bound = bindPhasePlan({ aws, phaseIdentity, validationRunId, sourceDigest, planDigest, predecessorPointer: predecessor?.pointer })
    return { schemaVersion: '1.0', phase, stage: phaseIdentity.stage, component: phaseIdentity.component, scenario: phaseIdentity.scenario, replay: false, resume: !bound.created, restoreResume: false, planDigest: bound.value.planDigest }
  }
  if (existingPlan) return { schemaVersion: '1.0', phase, stage: phaseIdentity.stage, component: phaseIdentity.component, scenario: phaseIdentity.scenario, replay: false, resume: true, restoreResume: false, planDigest: existingPlan.planDigest }
  return { schemaVersion: '1.0', phase, stage: phaseIdentity.stage, component: phaseIdentity.component, scenario: phaseIdentity.scenario, replay: false, resume: false, restoreResume: false }
}

export function recordPhaseCompletion({ aws, phase, validationRunId, sourceDigest, planDigest, result, completedAt = new Date() }) {
  assertRun(validationRunId, sourceDigest)
  const phaseIdentity = identity(phase)
  const manifest = readManifest(aws, phaseIdentity.stage)
  assert.equal(manifest.sourceDigest, sourceDigest, `${phaseIdentity.stage} manifest belongs to a different source digest`)
  const predecessor = predecessorEvidence(aws, phaseIdentity, validationRunId, sourceDigest)
  const plan = optionalPhasePlan(aws, phaseIdentity, validationRunId, sourceDigest, predecessor?.pointer)
  if (!plan) throw new Error(`phase ${phase} has no durable plan binding`)
  assert.equal(plan.planDigest, planDigest, `phase ${phase} completed under a different plan digest`)
  const resultSha256 = createHash('sha256').update(JSON.stringify(result)).digest('hex')
  const current = optionalPhaseEvidence(aws, phaseIdentity)
  if (current) {
    if (current.value?.validationRunId === validationRunId) {
      assertPhaseReceipt(current.value, { ...phaseIdentity, validationRunId, sourceDigest, planDigest }, predecessor?.pointer)
      if (current.value.resultSha256 !== resultSha256) {
        const lock = readRestoreLock(aws)
        assert(phase === 'restore-api-proof' && lock?.validationRunId === validationRunId && lock?.sourceDigest === sourceDigest && lock?.planDigest === planDigest, `phase ${phase} retry result changed without its exact active restore lock`)
      }
      return { pointer: current.pointer, receipt: current.value, replay: true }
    }
    assertHistoricalPhaseReceipt(current.value, phaseIdentity)
  }
  const receipt = assertPhaseReceipt({
    schemaVersion: '1.0', kind: 'work-1.2-phase-receipt', validationRunId,
    chainId: validationChainId(validationRunId, sourceDigest), sourceDigest, phase,
    phaseIndex: phaseIdentity.index + 1, stage: phaseIdentity.stage, component: phaseIdentity.component, scenario: phaseIdentity.scenario,
    requestId: `${validationRunId}-${phase}`, planDigest, predecessor: predecessor ? { phase: phaseIdentity.predecessor.phase, stage: phaseIdentity.predecessor.stage, versionId: predecessor.pointer.versionId, sha256: predecessor.pointer.sha256 } : null,
    resultSha256, completedAt: completedAt.toISOString(),
  }, { ...phaseIdentity, validationRunId, sourceDigest, planDigest }, predecessor?.pointer)
  const pointer = writeVersionedEvidence({ aws, stage: phaseIdentity.stage, kind: phaseEvidenceKind(phase), kmsKeyArn: manifest.custody.kmsKeyArn, value: receipt })
  return { pointer, receipt, replay: false }
}

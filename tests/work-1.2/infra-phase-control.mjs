import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { preflightPhase, recordPhaseCompletion, work12Phases } from '../../scripts/infra-phase-control.mjs'
import { buildRestoreLockBinding, createOrResumeRestoreLock, readRestoreLock } from '../../scripts/infra-restore-lock.mjs'

const validationRunId = 'github-2468'
const sourceDigest = '1'.repeat(40)
const kms = {
  'source-val12': 'arn:aws:kms:us-east-1:167217327520:key/11111111-2222-3333-4444-555555555555',
  'restore-val12': 'arn:aws:kms:us-east-1:167217327520:key/66666666-7777-8888-9999-aaaaaaaaaaaa',
}

function fixture() {
  const parameters = new Map()
  const objects = new Map()
  let version = 0
  for (const stage of ['source-val12', 'restore-val12']) parameters.set(`/stokd-agent/${stage}/infrastructure-manifest/v1`, JSON.stringify({
    schemaVersion: '1.0', stage, sourceDigest, custody: { kmsKeyArn: kms[stage] },
  }))
  const aws = args => {
    const [service, operation] = args
    const value = flag => args[args.indexOf(flag) + 1]
    if (service === 'ssm' && operation === 'get-parameter') {
      const name = value('--name')
      if (!parameters.has(name)) throw new Error('ParameterNotFound')
      return JSON.stringify({ Parameter: { Value: parameters.get(name) } })
    }
    if (service === 'ssm' && operation === 'put-parameter') {
      const name = value('--name')
      if (parameters.has(name) && !args.includes('--overwrite')) throw new Error('ParameterAlreadyExists')
      parameters.set(name, value('--value'))
      return JSON.stringify({ Version: 1 })
    }
    if (service === 'ssm' && operation === 'add-tags-to-resource') return '{}'
    if (service === 'ssm' && operation === 'delete-parameter') {
      if (!parameters.delete(value('--name'))) throw new Error('ParameterNotFound')
      return '{}'
    }
    if (service === 's3api' && operation === 'put-object') {
      const bytes = readFileSync(value('--body'))
      const versionId = `version-${String(++version).padStart(24, '0')}`
      const digest = value('--metadata').slice('sha256='.length)
      const eTag = createHash('md5').update(bytes).digest('hex')
      objects.set(`${value('--bucket')}/${value('--key')}/${versionId}`, { bytes, digest, eTag, kmsKeyArn: value('--ssekms-key-id'), versionId })
      return JSON.stringify({ VersionId: versionId, ETag: `"${eTag}"`, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: value('--ssekms-key-id') })
    }
    if (service === 's3api' && operation === 'head-object') {
      const item = objects.get(`${value('--bucket')}/${value('--key')}/${value('--version-id')}`)
      if (!item) throw new Error('NoSuchVersion')
      return JSON.stringify({ VersionId: item.versionId, ETag: `"${item.eTag}"`, ContentLength: item.bytes.byteLength, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: item.kmsKeyArn, Metadata: { sha256: item.digest } })
    }
    if (service === 's3api' && operation === 'get-object') {
      const item = objects.get(`${value('--bucket')}/${value('--key')}/${value('--version-id')}`)
      if (!item) throw new Error('NoSuchVersion')
      writeFileSync(args.at(-1), item.bytes)
      return JSON.stringify({ VersionId: item.versionId })
    }
    throw new Error(`unexpected AWS call: ${args.join(' ')}`)
  }
  return { aws, parameters, objects }
}

function completePhase(cloud, phase, digit) {
  const planDigest = digit.repeat(64)
  const first = preflightPhase({ aws: cloud.aws, phase, validationRunId, sourceDigest })
  assert.equal(first.replay, false)
  const bound = preflightPhase({ aws: cloud.aws, phase, validationRunId, sourceDigest, planDigest })
  assert.deepEqual({ replay: bound.replay, resume: bound.resume, planDigest: bound.planDigest }, { replay: false, resume: false, planDigest })
  return recordPhaseCompletion({ aws: cloud.aws, phase, validationRunId, sourceDigest, planDigest, result: { ok: true, phase } })
}

test('phase preflight binds a plan once, resumes read-only, and refuses changed input', () => {
  const cloud = fixture()
  const phase = work12Phases[0].phase
  const planDigest = '2'.repeat(64)
  assert.deepEqual({ replay: preflightPhase({ aws: cloud.aws, phase, validationRunId, sourceDigest }).replay, resume: false }, { replay: false, resume: false })
  const first = preflightPhase({ aws: cloud.aws, phase, validationRunId, sourceDigest, planDigest })
  assert.equal(first.resume, false)
  const retry = preflightPhase({ aws: cloud.aws, phase, validationRunId, sourceDigest })
  assert.deepEqual(retry, { ...first, resume: true })
  assert.equal(retry.restoreResume, false, 'ordinary incomplete plan must retry deploy rather than masquerade as restore recovery')
  assert.throws(() => preflightPhase({ aws: cloud.aws, phase, validationRunId, sourceDigest, planDigest: '3'.repeat(64) }), /plan digest changed after its durable binding/)
  const receipt = recordPhaseCompletion({ aws: cloud.aws, phase, validationRunId, sourceDigest, planDigest, result: { deployed: true } })
  assert.equal(receipt.receipt.planDigest, planDigest)
  assert.equal(preflightPhase({ aws: cloud.aws, phase, validationRunId, sourceDigest }).replay, true)
  const planName = `/stokd-agent/validation/work-1.2/runs/${validationRunId}/phases/${phase}/plan/v1`
  const planValue = cloud.parameters.get(planName)
  cloud.parameters.delete(planName)
  assert.throws(() => preflightPhase({ aws: cloud.aws, phase, validationRunId, sourceDigest }), /receipt has no durable plan binding/)
  cloud.parameters.set(planName, planValue)

  const pointerName = '/stokd-agent/validation/work-1.2/source-val12/phase-source-data/v1'
  const pointer = JSON.parse(cloud.parameters.get(pointerName))
  const object = cloud.objects.get(`${pointer.bucket}/${pointer.objectKey}/${pointer.versionId}`)
  const corrupted = Buffer.from(JSON.stringify({ ...JSON.parse(object.bytes), requestId: 'corrupt-same-run-request' }))
  object.bytes = corrupted
  object.digest = createHash('sha256').update(corrupted).digest('hex')
  pointer.sha256 = object.digest
  pointer.byteLength = corrupted.byteLength
  cloud.parameters.set(pointerName, JSON.stringify(pointer))
  const corruptPointer = cloud.parameters.get(pointerName)
  assert.throws(() => preflightPhase({ aws: cloud.aws, phase, validationRunId, sourceDigest }), /requestId|Expected values/)
  assert.throws(() => recordPhaseCompletion({ aws: cloud.aws, phase, validationRunId, sourceDigest, planDigest, result: { deployed: true } }), /requestId|Expected values/)
  assert.equal(cloud.parameters.get(pointerName), corruptPointer, 'same-run corrupt receipt was overwritten')
})

test('phase chain rejects skipped, mixed-run, mixed-source, and corrupt grand predecessors', () => {
  const empty = fixture()
  assert.throws(() => preflightPhase({ aws: empty.aws, phase: work12Phases[1].phase, validationRunId, sourceDigest }), /missing its immutable receipt/)

  const cloud = fixture()
  completePhase(cloud, work12Phases[0].phase, '2')
  assert.throws(() => preflightPhase({ aws: cloud.aws, phase: work12Phases[1].phase, validationRunId: 'github-999', sourceDigest }), /different|invalid predecessor chain/)
  assert.throws(() => preflightPhase({ aws: cloud.aws, phase: work12Phases[1].phase, validationRunId, sourceDigest: '9'.repeat(40) }), /different|invalid predecessor chain/)
  completePhase(cloud, work12Phases[1].phase, '3')

  const firstPointerName = '/stokd-agent/validation/work-1.2/source-val12/phase-source-data/v1'
  const firstPointer = JSON.parse(cloud.parameters.get(firstPointerName))
  const objectId = `${firstPointer.bucket}/${firstPointer.objectKey}/${firstPointer.versionId}`
  const object = cloud.objects.get(objectId)
  const corrupted = Buffer.from(JSON.stringify({ ...JSON.parse(object.bytes), validationRunId: 'github-999' }))
  object.bytes = corrupted
  object.digest = createHash('sha256').update(corrupted).digest('hex')
  firstPointer.sha256 = object.digest
  firstPointer.byteLength = corrupted.byteLength
  cloud.parameters.set(firstPointerName, JSON.stringify(firstPointer))
  assert.throws(() => preflightPhase({ aws: cloud.aws, phase: work12Phases[2].phase, validationRunId, sourceDigest }), /invalid predecessor chain/)
})

test('foreign/malformed locks fail closed and same binding resumes after receipt-before-unlock crash', () => {
  const cloud = fixture()
  completePhase(cloud, work12Phases[0].phase, '2')
  completePhase(cloud, work12Phases[1].phase, '3')
  completePhase(cloud, work12Phases[2].phase, '4')
  const phase = work12Phases[3].phase
  const planDigest = '5'.repeat(64)
  preflightPhase({ aws: cloud.aws, phase, validationRunId, sourceDigest, planDigest })
  const resources = suffix => ({ artifactBucket: `artifacts-${suffix}`, backupBucket: `backups-${suffix}`, databaseVolumeId: `vol-${suffix}`, kmsKeyArn: `kms-${suffix}`, mongoInstanceId: `i-${suffix}` })
  const binding = buildRestoreLockBinding({ validationRunId, sourceDigest, planDigest, operationId: `work12-${'a'.repeat(32)}`, sourceResourceIds: resources('source'), targetResourceIds: resources('restore'), selectedBackup: { versionId: 'backup-v1' } })
  assert.equal(createOrResumeRestoreLock({ aws: cloud.aws, binding, now: () => new Date('2026-09-02T00:00:00.000Z') }).resumed, false)
  assert.equal(createOrResumeRestoreLock({ aws: cloud.aws, binding, now: () => new Date('2026-09-02T00:01:00.000Z') }).resumed, true)
  assert.throws(() => createOrResumeRestoreLock({ aws: cloud.aws, binding: { ...binding, inputBindingSha256: 'f'.repeat(64) } }), /different restore admission lock/)
  recordPhaseCompletion({ aws: cloud.aws, phase, validationRunId, sourceDigest, planDigest, result: { restoreVerified: true } })
  const resume = preflightPhase({ aws: cloud.aws, phase, validationRunId, sourceDigest })
  assert.deepEqual({ replay: resume.replay, resume: resume.resume, restoreResume: resume.restoreResume, planDigest: resume.planDigest }, { replay: false, resume: true, restoreResume: true, planDigest })
  assert(readRestoreLock(cloud.aws))

  const lockName = '/stokd-agent/validation/work-1.2/restore-admission-lock/v1'
  cloud.parameters.set(lockName, JSON.stringify({ schemaVersion: '0.0' }))
  assert.throws(() => preflightPhase({ aws: cloud.aws, phase, validationRunId, sourceDigest }), /fields changed|restore admission lock/)
})

test('workflow distinguishes bound-plan deploy recovery from active-restore verification recovery', () => {
  const workflow = readFileSync('.github/workflows/agent-validation.yml', 'utf8')
  const scenario = readFileSync('scripts/infra-validation-scenario.mjs', 'utf8')
  assert.match(workflow, /if json_true "\$preflight" restoreResume; then[\s\S]*resuming verification without deployment mutation/)
  assert.match(workflow, /else[\s\S]*republishing deterministic images and retrying deploy[\s\S]*infra-publish-images\.mjs[\s\S]*infra-action\.mjs "\$component" deploy/)
  assert.match(workflow, /infra-phase-preflight\.mjs --phase "\$phase"[\s\S]*--plan-digest "\$AGENT_PLAN_DIGEST"/)
  assert.match(scenario, /const restoreLock = createOrResumeRestoreLock[\s\S]*if \(!restoreLock\.resumed\) \{[\s\S]*currentApi\(manifest\)/)
  const reuse = scenario.indexOf('if (reusePriorEvidence)')
  const resumedReturn = scenario.indexOf('evidenceVersionIds:', reuse)
  const resumedWrite = scenario.indexOf("writeEvidence(stage, 'fixture'", reuse)
  assert(reuse >= 0 && resumedReturn > reuse && resumedWrite > resumedReturn, 'completed restore retry must return existing version IDs before any evidence overwrite')
})

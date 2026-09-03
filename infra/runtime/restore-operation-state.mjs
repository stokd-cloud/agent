import { closeSync, fsyncSync, linkSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'

const [mode, statePath, operationId, inputBinding, ...args] = process.argv.slice(2)
const receiptsDirectory = '/var/lib/stokd-agent/receipts'
const activePath = `${receiptsDirectory}/restore-active.json`

function readJsonFile(path, label) {
  const stat = statSync(path)
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== 0) throw new Error(`${label} custody is invalid`)
  return JSON.parse(readFileSync(path, 'utf8'))
}
function validateGenericOperationState(path) {
  const value = readJsonFile(path, 'operation state')
  if (value.schemaVersion !== '1.0' || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(value.operationId ?? '') || !/^[a-f0-9]{64}$/.test(value.inputBinding ?? '')) throw new Error('operation state identity is invalid')
  if (Object.keys(value).sort().join(',') !== 'inputBinding,operationId,phase,schemaVersion,secretVersions') throw new Error('operation state has unknown fields')
  if (!['initialized', 'downloaded', 'secrets_planned', 'secrets_bound', 'offline_complete', 'finalized', 'complete'].includes(value.phase)) throw new Error('operation state phase is invalid')
  return value
}
function incompleteOperations() {
  return readdirSync(receiptsDirectory)
    .filter(name => /^restore-operation-[a-z0-9][a-z0-9-]{2,80}\.json$/.test(name))
    .map(name => validateGenericOperationState(`${receiptsDirectory}/${name}`))
    .filter(value => value.phase !== 'complete')
}
function readActive() {
  const value = readJsonFile(activePath, 'active restore binding')
  if (Object.keys(value).sort().join(',') !== 'inputBinding,operationId,schemaVersion,statePath,status' || value.schemaVersion !== '1.0' || value.status !== 'active') throw new Error('active restore binding is invalid')
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(value.operationId ?? '') || !/^[a-f0-9]{64}$/.test(value.inputBinding ?? '') || value.statePath !== `${receiptsDirectory}/restore-operation-${value.operationId}.json`) throw new Error('active restore identity is invalid')
  return value
}
function fsyncDirectory() {
  const directory = openSync(receiptsDirectory, 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

if (mode === 'assert-no-active') {
  let active
  try { active = readActive() } catch (error) { if (error?.code !== 'ENOENT') throw error }
  const incomplete = incompleteOperations()
  if (active || incomplete.length) throw new Error('an incomplete restore operation owns this stage')
  process.stdout.write('clear\n')
  process.exit(0)
}
const parent = statePath ? realpathSync(dirname(statePath)) : ''
if (!statePath || resolve(statePath) !== statePath || parent !== receiptsDirectory || basename(statePath) !== `restore-operation-${operationId}.json`) throw new Error('operation state path is not exact')
if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(operationId ?? '') || !/^[a-f0-9]{64}$/.test(inputBinding ?? '')) throw new Error('operation identity is invalid')

if (mode === 'active-bind') {
  const expected = { schemaVersion: '1.0', status: 'active', operationId, inputBinding, statePath }
  try {
    const existing = validateGenericOperationState(statePath)
    if (existing.operationId !== operationId || existing.inputBinding !== inputBinding) throw new Error('existing restore operation input binding changed')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const operation of incompleteOperations()) {
    if (operation.operationId !== operationId || operation.inputBinding !== inputBinding) throw new Error('a different incomplete restore operation owns this stage')
  }
  const temporary = `${receiptsDirectory}/restore-active.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(expected)); fsyncSync(fd); closeSync(fd); fd = undefined
    try { linkSync(temporary, activePath); fsyncDirectory() } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (JSON.stringify(readActive()) !== JSON.stringify(expected)) throw new Error('a different active restore operation owns this stage')
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
  process.stdout.write('bound\n')
  process.exit(0)
}

if (mode === 'active-release') {
  const active = readActive()
  if (active.operationId !== operationId || active.inputBinding !== inputBinding || active.statePath !== statePath) throw new Error('active restore release identity changed')
  const completed = validateGenericOperationState(statePath)
  if (completed.operationId !== operationId || completed.inputBinding !== inputBinding || completed.phase !== 'complete') throw new Error('active restore cannot be released before exact completion')
  unlinkSync(activePath)
  fsyncDirectory()
  process.stdout.write('released\n')
  process.exit(0)
}

function read() {
  const state = readJsonFile(statePath, 'operation state')
  if (state.schemaVersion !== '1.0' || state.operationId !== operationId || state.inputBinding !== inputBinding) throw new Error('operation state input binding changed')
  if (Object.keys(state).sort().join(',') !== 'inputBinding,operationId,phase,schemaVersion,secretVersions') throw new Error('operation state has unknown fields')
  if (!['initialized', 'downloaded', 'secrets_planned', 'secrets_bound', 'offline_complete', 'finalized', 'complete'].includes(state.phase)) throw new Error('operation state phase is invalid')
  if (state.secretVersions !== null) {
    if (Object.keys(state.secretVersions).sort().join(',') !== 'backup,migration,runtime') throw new Error('operation secret version state is invalid')
    for (const value of Object.values(state.secretVersions)) {
      if (Object.keys(value).sort().join(',') !== 'newVersionId,previousVersionId' || !/^[A-Za-z0-9-]{32,64}$/.test(value.previousVersionId) || !/^[a-f0-9]{64}$/.test(value.newVersionId)) throw new Error('operation secret version binding is invalid')
    }
  }
  return state
}
function write(state) {
  const temporary = `${statePath}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); closeSync(fd); fd = undefined
    renameSync(temporary, statePath)
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
  fsyncDirectory()
}
if (mode === 'init') {
  try { read() } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    write({ schemaVersion: '1.0', operationId, inputBinding, phase: 'initialized', secretVersions: null })
  }
} else if (mode === 'plan-secrets') {
  if (
    args.length !== 6 ||
    [args[0], args[2], args[4]].some(value => !/^[A-Za-z0-9-]{32,64}$/.test(value)) ||
    [args[1], args[3], args[5]].some(value => !/^[a-f0-9]{64}$/.test(value))
  ) throw new Error('three previous and three deterministic new secret VersionIds are required')
  const state = read()
  const versions = {
    runtime: { previousVersionId: args[0], newVersionId: args[1] },
    migration: { previousVersionId: args[2], newVersionId: args[3] },
    backup: { previousVersionId: args[4], newVersionId: args[5] },
  }
  if (state.phase === 'downloaded' && state.secretVersions === null) write({ ...state, phase: 'secrets_planned', secretVersions: versions })
  else if (['secrets_planned', 'secrets_bound', 'offline_complete', 'finalized', 'complete'].includes(state.phase) && JSON.stringify(state.secretVersions) === JSON.stringify(versions)) { /* idempotent */ }
  else throw new Error('operation secret VersionIds cannot be rebound')
} else if (mode === 'bind-secrets') {
  const state = read()
  if (state.phase === 'secrets_planned') write({ ...state, phase: 'secrets_bound' })
  else if (state.phase !== 'secrets_bound') throw new Error('operation secrets were not pre-planned')
} else if (mode === 'advance') {
  if (args.length !== 2) throw new Error('advance requires expected and next phase')
  const order = ['initialized', 'downloaded', 'secrets_planned', 'secrets_bound', 'offline_complete', 'finalized', 'complete']
  const [expected, next] = args
  if (order.indexOf(next) !== order.indexOf(expected) + 1) throw new Error('operation phase transition is invalid')
  const state = read()
  if (state.phase === next) { /* idempotent */ }
  else if (state.phase === expected) write({ ...state, phase: next })
  else throw new Error(`operation phase is ${state.phase}, expected ${expected}`)
} else if (mode !== 'fields') throw new Error('operation state mode is invalid')

const state = read()
const versions = state.secretVersions
process.stdout.write([state.phase, versions?.runtime?.previousVersionId ?? '-', versions?.runtime?.newVersionId ?? '-', versions?.migration?.previousVersionId ?? '-', versions?.migration?.newVersionId ?? '-', versions?.backup?.previousVersionId ?? '-', versions?.backup?.newVersionId ?? '-'].join('\t') + '\n')

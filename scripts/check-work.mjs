import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs, requireValue } from './lib/args.mjs'
import { computeBuildFingerprint } from './lib/build-fingerprint.mjs'
import { validateWorkScenarioMapping } from './lib/scenario-mapping.mjs'
import { validateCanonicalScenarioCommands } from './lib/canonical-work.mjs'
import { verifyPinnedToolchain } from './lib/toolchain.mjs'

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const WORK_MANIFEST = join(root, 'tests/verification/work-items.json')
const BUILD_FINGERPRINT = join(root, 'tests/verification/build-fingerprint.json')
const EXPECTED_WORK_MANIFEST_SHA256 = '17f9f765aa84faf2629760edab6cbcb62fc87a5dcf5977739120534a5b07a318'
const EXPECTED_BUILD_FINGERPRINT_SHA256 = '8b537485866732ff9c887a131b68e0080212d2d3b20932b0589a0d0a17890b05'
const EXPECTED_PNPM_VERSION = '11.25.0'

const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')

function inside(base, path) {
  const rel = relative(base, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function rawOption(argv, name) {
  const indices = argv.flatMap((value, index) => value === `--${name}` ? [index] : [])
  if (indices.length !== 1) return null
  const value = argv[indices[0] + 1]
  return typeof value === 'string' && !value.startsWith('--') && value.length > 0 ? value : null
}

function canonicalEvidenceDirectory(item, evidenceArg) {
  if (!/^\d+\.\d+$/.test(item)) throw new Error(`invalid work item identifier: ${item}`)
  const expected = join(root, 'evidence', 'work', item)
  if (resolve(root, evidenceArg) !== expected) throw new Error(`canonical evidence path must be evidence/work/${item}`)
  let current = root
  for (const segment of ['evidence', 'work', item]) {
    current = join(current, segment)
    if (existsSync(current)) {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) throw new Error(`canonical evidence path contains a symlink: ${current}`)
      if (!stat.isDirectory()) throw new Error(`canonical evidence component is not a directory: ${current}`)
    } else {
      mkdirSync(current)
    }
  }
  const canonical = realpathSync(current)
  if (canonical !== expected || !inside(join(root, 'evidence', 'work'), canonical)) {
    throw new Error(`canonical evidence path escaped repository: ${canonical}`)
  }
  return canonical
}

function sourceTreeDigest() {
  const listed = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'buffer' })
  if (listed.status !== 0) throw new Error('could not enumerate source tree')
  const paths = listed.stdout.toString('utf8').split('\0').filter(Boolean).filter(path => !path.startsWith('evidence/')).sort()
  const hash = createHash('sha256')
  for (const path of paths) {
    const absolute = join(root, path)
    const stat = lstatSync(absolute)
    hash.update(`${path}\0${stat.mode}\0`)
    if (stat.isFile()) hash.update(readFileSync(absolute))
    else if (stat.isSymbolicLink()) hash.update(readlinkSync(absolute))
    else hash.update(spawnSync('git', ['ls-files', '-s', '--', path], { cwd: root, encoding: 'utf8' }).stdout)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function sourceIdentity() {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (git.status !== 0) throw new Error('could not resolve source HEAD')
  return { sourceHead: git.stdout.trim(), sourceTreeSha256: sourceTreeDigest() }
}

function canonicalBuildFingerprint() {
  const manifestSha256 = sha(BUILD_FINGERPRINT)
  if (manifestSha256 !== EXPECTED_BUILD_FINGERPRINT_SHA256) {
    throw new Error(`canonical build fingerprint manifest drift: ${manifestSha256}`)
  }
  const expected = JSON.parse(readFileSync(BUILD_FINGERPRINT, 'utf8'))
  const actual = computeBuildFingerprint(root)
  assert.deepEqual(actual, expected, 'build/source fingerprint mismatch')
  return { manifestSha256, value: actual }
}

function findPnpmPackage(path) {
  let current = dirname(path)
  for (;;) {
    const candidate = join(current, 'package.json')
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
      if (manifest.name === 'pnpm') return { root: current, manifest }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`npm_execpath is not inside a pnpm package: ${path}`)
}

function resolvePnpm() {
  const workspace = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (workspace.packageManager !== `pnpm@${EXPECTED_PNPM_VERSION}`) {
    throw new Error(`workspace packageManager must be pnpm@${EXPECTED_PNPM_VERSION}`)
  }
  const declared = process.env.npm_execpath
  if (!declared || !isAbsolute(declared)) throw new Error('canonical check-work must be invoked through pnpm; npm_execpath is missing')
  const executable = realpathSync(declared)
  if (!statSync(executable).isFile()) throw new Error(`pnpm npm_execpath is not a regular file: ${executable}`)
  const packageInfo = findPnpmPackage(executable)
  if (packageInfo.manifest.version !== EXPECTED_PNPM_VERSION) {
    throw new Error(`pnpm package version mismatch: ${packageInfo.manifest.version ?? '<missing>'}`)
  }
  const env = { ...process.env, NODE_PATH: '' }
  delete env.NODE_OPTIONS
  const probe = spawnSync(process.execPath, [executable, '--version'], { cwd: root, encoding: 'utf8', env })
  if (probe.status !== 0 || probe.stdout.trim() !== EXPECTED_PNPM_VERSION) {
    throw new Error(`pnpm version mismatch: ${probe.stdout.trim() || '<missing>'}`)
  }
  return {
    executable,
    executableSha256: sha(executable),
    packageRoot: realpathSync(packageInfo.root),
    version: EXPECTED_PNPM_VERSION,
  }
}

function atomicSummary(dir, value) {
  const path = join(dir, 'summary.json')
  const temporary = join(dir, `.summary.${process.pid}.${randomUUID()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, path)
}

let evidence = null
let runDir = null
let runState = null
let partialResults = []
let completed = false

function persistFailedArtifacts() {
  if (!evidence || !runDir || !existsSync(runDir) || !runState?.runId) return null
  const failedRoot = join(evidence, 'failed')
  if (!existsSync(failedRoot)) mkdirSync(failedRoot)
  const stat = lstatSync(failedRoot)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('failed evidence directory is not a canonical directory')
  const destination = join(failedRoot, runState.runId)
  renameSync(runDir, destination)
  runDir = null
  return relative(evidence, destination)
}

function incomplete(state, error, failureEvidencePath = null) {
  if (!evidence || completed) return
  const value = {
    ...runState,
    state,
    canonicalPass: false,
    sealed: false,
    disposition: 'work-check-incomplete',
    executedScenarioCount: partialResults.length,
    results: partialResults,
    ...(failureEvidencePath ? { failureEvidencePath } : {}),
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  }
  try { atomicSummary(evidence, value) } catch {}
}

function interrupt(signal, exitCode) {
  let failureEvidencePath = null
  try { failureEvidencePath = persistFailedArtifacts() } catch {}
  incomplete('interrupted', new Error(signal), failureEvidencePath)
  process.exit(exitCode)
}

try {
  const rawArgs = process.argv.slice(2)
  const rawItem = rawOption(rawArgs, 'item')
  const rawEvidence = rawOption(rawArgs, 'evidence')
  if (rawItem && rawEvidence) {
    evidence = canonicalEvidenceDirectory(rawItem, rawEvidence)
    runState = {
      schemaVersion: '1.0',
      item: rawItem,
      runId: randomUUID(),
      startedAt: new Date().toISOString(),
      sourceHead: 'pending',
      sourceTreeSha256: 'pending',
    }
    atomicSummary(evidence, { ...runState, state: 'running', canonicalPass: false, sealed: false, disposition: 'work-check-incomplete', executedScenarioCount: 0, results: [] })
    process.once('SIGINT', () => interrupt('SIGINT', 130))
    process.once('SIGTERM', () => interrupt('SIGTERM', 143))
  }

  const args = parseArgs(rawArgs)
  const item = requireValue(args, 'item')
  const evidenceArg = requireValue(args, 'evidence')
  if (!evidence) throw new Error('canonical evidence path could not be initialized')
  if (item !== rawItem || evidenceArg !== rawEvidence) throw new Error('canonical work arguments are ambiguous')
  if (args.flags.size > 0 || [...args.values.keys()].some(key => key !== 'item' && key !== 'evidence')) {
    throw new Error('canonical check-work accepts only --item and --evidence')
  }
  if (process.env.AGENT_WORK_MANIFEST) throw new Error('AGENT_WORK_MANIFEST override is forbidden for canonical evidence')
  if (process.env.AGENT_ALLOW_MOCKS || process.env.AGENT_MOCK_MODE) throw new Error('unauthorized mock substitution is forbidden')
  if (process.env.AGENT_WORK_CHECK_SETUP === 'missing') throw new Error('required work-check setup is missing')

  const manifestSha256 = sha(WORK_MANIFEST)
  if (manifestSha256 !== EXPECTED_WORK_MANIFEST_SHA256) throw new Error(`canonical work manifest drift: ${manifestSha256}`)
  const registry = JSON.parse(readFileSync(WORK_MANIFEST, 'utf8'))
  const entry = registry.items?.[item]
  if (!entry) throw new Error(`unknown work item: ${item}`)
  const contracts = JSON.parse(readFileSync(join(root, 'tests/contracts/targets.json'), 'utf8'))
  const coverage = validateWorkScenarioMapping(contracts, item, entry)
  const commands = validateCanonicalScenarioCommands(root, item, entry)
  if (commands.length !== entry.scenarios.length) throw new Error('canonical command coverage mismatch')

  const toolchain = verifyPinnedToolchain(root)
  const pnpm = resolvePnpm()
  const startIdentity = sourceIdentity()
  const startBuild = canonicalBuildFingerprint()
  runState = {
    ...runState,
    ...startIdentity,
    canonicalManifestSha256: manifestSha256,
    buildFingerprintManifestSha256: startBuild.manifestSha256,
    buildFingerprint: startBuild.value,
    toolchain,
    mappedScenarioCount: entry.scenarios.length,
  }
  atomicSummary(evidence, { ...runState, state: 'running', canonicalPass: false, sealed: false, disposition: 'work-check-incomplete', executedScenarioCount: 0, results: [] })
  runDir = mkdtempSync(join(dirname(evidence), `.${item}.run-`))

  for (const scenario of entry.scenarios) {
    const command = commands.find(value => value.id === scenario.id)
    const childEnv = {
      ...process.env,
      AGENT_WORK_EVIDENCE: evidence,
      AGENT_PNPM_EXEC_PATH: pnpm.executable,
      NODE_PATH: '',
    }
    delete childEnv.NODE_OPTIONS
    const result = spawnSync(process.execPath, [command.canonicalScript], { cwd: root, encoding: 'utf8', env: childEnv })
    const output = `$ ${process.execPath} ${command.canonicalScript}\nexit=${result.status}\nsignal=${result.signal ?? '<none>'}\n\n[stdout]\n${result.stdout}\n[stderr]\n${result.stderr}`
    writeFileSync(join(runDir, `${scenario.id}.txt`), output)
    const row = {
      id: scenario.id,
      command: ['node', command.script],
      targets: scenario.targets,
      registeredScenarios: scenario.registeredScenarios,
      exitCode: result.status,
      signal: result.signal ?? null,
      verdict: result.status === 0 ? 'pass' : 'fail',
    }
    partialResults.push(row)
    incomplete('running')
    if (result.status !== 0) throw new Error(`work scenario failed: ${scenario.id}`)
  }

  if (partialResults.length !== entry.scenarios.length || coverage.scenarioIds.length !== entry.scenarios.length) {
    throw new Error('executed scenario count does not match mapped scenario count')
  }
  const endIdentity = sourceIdentity()
  assert.deepEqual(endIdentity, startIdentity, 'source identity drifted during canonical work check')
  const endBuild = canonicalBuildFingerprint()
  assert.deepEqual(endBuild, startBuild, 'build/source fingerprint drifted during canonical work check')
  const summary = {
    ...runState,
    state: 'complete',
    canonicalPass: true,
    sealed: false,
    disposition: 'work-check-only',
    finishedAt: new Date().toISOString(),
    workingTreeDiffSha256: createHash('sha256').update(spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, encoding: 'buffer' }).stdout).digest('hex'),
    lockfileSha256: sha(join(root, 'pnpm-lock.yaml')),
    coverage,
    executedScenarioCount: partialResults.length,
    mappedScenarioCount: entry.scenarios.length,
    environment: {
      node: process.version,
      pnpm: pnpm.version,
      pnpmExecutable: pnpm.executable,
      pnpmExecutableSha256: pnpm.executableSha256,
      pnpmPackageRoot: pnpm.packageRoot,
      platform: process.platform,
      arch: process.arch,
    },
    results: partialResults,
  }
  for (const existing of readdirSync(evidence, { withFileTypes: true })) {
    if (existing.isFile() && existing.name.endsWith('.txt')) rmSync(join(evidence, existing.name), { force: true })
  }
  for (const scenario of entry.scenarios) renameSync(join(runDir, `${scenario.id}.txt`), join(evidence, `${scenario.id}.txt`))
  rmSync(runDir, { recursive: true, force: true })
  runDir = null
  atomicSummary(evidence, summary)
  completed = true
  console.log(JSON.stringify(summary, null, 2))
} catch (error) {
  let failureEvidencePath = null
  try { failureEvidencePath = persistFailedArtifacts() } catch (persistError) {
    error = new AggregateError([error, persistError], 'work check and failure evidence persistence both failed')
  }
  incomplete('failed', error, failureEvidencePath)
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 2
} finally {
  if (runDir) rmSync(runDir, { recursive: true, force: true })
}

#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = 'stokd-cloud/agent'
const environmentName = 'agent-validation'
const branch = 'project/d7f02e6-cloud-agents-mvp'
const reviewer = { type: 'User', id: 91224556, login: 'brian-stoker' }
const digest = createHash('sha256')
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(readFileSync(resolve(root, '.github/workflows/agent-validation.yml')))
  .digest('hex')
const acknowledgement = `agent-github-environment/v1/${digest}`

function gh(args, body, { allowNotFound = false } = {}) {
  const result = spawnSync('gh', ['api', ...args], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    input: body === undefined ? undefined : `${JSON.stringify(body)}\n`,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim()
    if (allowNotFound && /(?:HTTP|status(?: code)?)\s*404|Not Found/i.test(detail)) return undefined
    throw new Error(`GitHub environment request failed: ${detail}`)
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined
}

function assertGitHubEnvironmentControls(environment) {
  const branchPolicy = environment?.deployment_branch_policy
  if (environment?.name !== environmentName || branchPolicy?.protected_branches !== false || branchPolicy?.custom_branch_policies !== true) {
    throw new Error('agent-validation must use custom deployment branch policies only')
  }
  const reviewers = (environment.protection_rules ?? []).flatMap(rule => rule.type === 'required_reviewers' ? rule.reviewers ?? [] : [])
  if (reviewers.length !== 1 || reviewers[0]?.type !== reviewer.type || reviewers[0]?.reviewer?.id !== reviewer.id || reviewers[0]?.reviewer?.login !== reviewer.login) {
    throw new Error('agent-validation must require the exact reviewed administrator')
  }
}

export function assertGitHubEnvironment(environment, policies) {
  assertGitHubEnvironmentControls(environment)
  const observed = policies?.branch_policies ?? []
  if (observed.length !== 1 || observed[0]?.name !== branch || observed[0]?.type !== 'branch') {
    throw new Error(`agent-validation must allow only the ${branch} branch`)
  }
}

function assertPristineGitHubEnvironment(environment, policies) {
  if (environment?.name !== environmentName || environment?.deployment_branch_policy !== null || (environment.protection_rules ?? []).length !== 0) {
    throw new Error('new agent-validation did not have the pristine default controls')
  }
  if ((policies?.branch_policies ?? []).length !== 0) throw new Error('new agent-validation unexpectedly gained a branch policy')
}

function readback() {
  const base = `repos/${repository}/environments/${environmentName}`
  const environment = gh([base])
  const policies = gh(['--method', 'GET', `${base}/deployment-branch-policies`, '-f', 'per_page=100'])
  assertGitHubEnvironment(environment, policies)
  process.stdout.write(`${JSON.stringify({ schemaVersion: '1.0', repository, environment: environmentName, reviewer, branch })}\n`)
}

export function ensureGitHubEnvironment(api) {
  const existing = api.getEnvironment()
  if (existing !== undefined) {
    assertGitHubEnvironment(existing, api.getPolicies())
    return { created: false, mutated: false }
  }

  // GraphQL createEnvironment returns an existing environment without updating
  // it. That gives this path a non-overwriting create primitive; every later
  // mutation is preceded and followed by exact readback.
  api.createEnvironment()
  const pristine = api.getEnvironment()
  if (pristine === undefined) throw new Error('agent-validation creation did not produce a readable environment')
  assertPristineGitHubEnvironment(pristine, api.getPolicies())
  api.configureEnvironment({
    wait_timer: 0,
    prevent_self_review: false,
    reviewers: [{ type: reviewer.type, id: reviewer.id }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  })
  const configured = api.getEnvironment()
  if (configured === undefined) throw new Error('agent-validation configuration did not produce a readable environment')
  const initialPolicies = api.getPolicies()
  assertGitHubEnvironmentControls(configured)
  if ((initialPolicies?.branch_policies ?? []).length !== 0) throw new Error('agent-validation gained a branch policy before its exact create')
  api.createBranchPolicy({ name: branch, type: 'branch' })
  assertGitHubEnvironment(api.getEnvironment(), api.getPolicies())
  return { created: true, mutated: true }
}

export function run(argv = process.argv.slice(2), environment = process.env) {
  if (argv.length === 1 && argv[0] === 'acknowledge') {
    process.stdout.write(`${acknowledgement}\n`)
    return 0
  }
  if (argv.length === 1 && argv[0] === 'verify') {
    readback()
    return 0
  }
  if (argv.length !== 3 || argv[0] !== 'apply' || argv[1] !== '--ack' || argv[2] !== acknowledgement || environment.AGENT_GITHUB_ENVIRONMENT_ACK !== acknowledgement) {
    throw new Error('usage: infra-github-environment.mjs acknowledge | verify | apply --ack <reviewed-digest>')
  }
  const base = `repos/${repository}/environments/${environmentName}`
  const repositoryRecord = gh([`repos/${repository}`])
  if (!/^R_[A-Za-z0-9_=-]+$/.test(repositoryRecord?.node_id ?? '')) throw new Error('repository GraphQL node ID is unavailable')
  const createMutation = 'mutation($repositoryId:ID!,$name:String!,$clientMutationId:String!){createEnvironment(input:{repositoryId:$repositoryId,name:$name,clientMutationId:$clientMutationId}){clientMutationId environment{id name}}}'
  ensureGitHubEnvironment({
    getEnvironment: () => gh([base], undefined, { allowNotFound: true }),
    getPolicies: () => gh(['--method', 'GET', `${base}/deployment-branch-policies`, '-f', 'per_page=100']),
    createEnvironment: () => gh(['graphql', '-f', `query=${createMutation}`, '-f', `repositoryId=${repositoryRecord.node_id}`, '-f', `name=${environmentName}`, '-f', `clientMutationId=${acknowledgement}`]),
    configureEnvironment: body => gh(['--method', 'PUT', base, '--input', '-'], body),
    createBranchPolicy: body => gh(['--method', 'POST', `${base}/deployment-branch-policies`, '--input', '-'], body),
  })
  readback()
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run() }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2 }
}

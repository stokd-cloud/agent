import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERRAFORM_ACTIONS, backendConfig, planArguments, runTerraform, variableArguments } from '../../scripts/infra-terraform.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pinned = {
  AGENT_SOURCE_DIGEST: 'a'.repeat(40),
  AGENT_API_IMAGE: '167217327520.dkr.ecr.us-east-1.amazonaws.com/stokd-agent-runtime@sha256:' + 'b'.repeat(64),
  AGENT_MONGO_IMAGE: '167217327520.dkr.ecr.us-east-1.amazonaws.com/stokd-agent-runtime@sha256:' + 'c'.repeat(64),
  AGENT_MAINTENANCE_IMAGE: '167217327520.dkr.ecr.us-east-1.amazonaws.com/stokd-agent-runtime@sha256:' + 'd'.repeat(64),
  AGENT_TFSTATE_BUCKET: 'stokd-agent-tfstate-167217327520',
  AGENT_TFSTATE_KMS_KEY_ID: 'alias/stokd-agent-tfstate',
}

test('the pipeline no longer executes SST', () => {
  const action = readFileSync(resolve(root, 'scripts/infra-action.mjs'), 'utf8')
  assert.doesNotMatch(action, /node_modules[^\n]*\.bin[^\n]*sst/, 'infra-action must not spawn the SST CLI')
  assert.doesNotMatch(action, /sst\.config\.ts/, 'infra-action must not resolve an SST config')
  assert.match(action, /runTerraform\(/, 'infra-action must drive Terraform')
})

test('actions map onto terraform verbs', () => {
  assert.deepEqual(TERRAFORM_ACTIONS, { diff: 'plan', deploy: 'apply', remove: 'destroy' })
})

test('encrypted remote state is required, never defaulted', () => {
  assert.throws(() => backendConfig('source-val12', {}), /AGENT_TFSTATE_BUCKET is required/)
  assert.throws(() => backendConfig('source-val12', { AGENT_TFSTATE_BUCKET: 'b' }), /AGENT_TFSTATE_KMS_KEY_ID is required/)
  const config = backendConfig('source-val12', pinned)
  assert.ok(config.includes('-backend-config=encrypt=true'))
  assert.ok(config.includes('-backend-config=key=work-1.2/source-val12/terraform.tfstate'))
})

test('each stage gets its own state key', () => {
  const source = backendConfig('source-val12', pinned).find(a => a.startsWith('-backend-config=key='))
  const restore = backendConfig('restore-val12', pinned).find(a => a.startsWith('-backend-config=key='))
  assert.notEqual(source, restore, 'stages must not share Terraform state')
})

test('pinned image digests and source commit are mandatory', () => {
  assert.throws(() => variableArguments({}), /missing exact pinned inputs/)
  assert.throws(() => variableArguments({ ...pinned, AGENT_API_IMAGE: '' }), /api_image/)
  assert.equal(variableArguments(pinned).length, 4)
})

test('plan never auto-approves and apply always does', () => {
  assert.ok(!planArguments('source-val12', 'plan').includes('-auto-approve'))
  assert.ok(planArguments('source-val12', 'apply').includes('-auto-approve'))
  assert.ok(planArguments('source-val12', 'destroy').includes('-auto-approve'))
})

test('an unsupported action is refused before terraform runs', () => {
  assert.throws(
    () => runTerraform({ action: 'launch', stage: 'source-val12', root }, pinned, () => { throw new Error('must not spawn') }),
    /unsupported action/,
  )
})

test('init runs before the action, with the backend, and a failed init short-circuits', () => {
  const calls = []
  const spawn = (cmd, args) => { calls.push([cmd, args]); return { status: args[0] === 'init' ? 0 : 0 } }
  const status = runTerraform({ action: 'deploy', stage: 'source-val12', root }, pinned, spawn)
  assert.equal(status, 0)
  assert.equal(calls.length, 2)
  assert.deepEqual([calls[0][0], calls[0][1][0]], ['terraform', 'init'])
  assert.ok(calls[0][1].some(a => a.startsWith('-backend-config=bucket=')))
  assert.deepEqual([calls[1][0], calls[1][1][0]], ['terraform', 'apply'])
  assert.ok(calls[1][1].includes('-var-file=envs/source-val12.tfvars'))

  const failing = []
  const failInit = (cmd, args) => { failing.push(args[0]); return { status: args[0] === 'init' ? 3 : 0 } }
  assert.equal(runTerraform({ action: 'diff', stage: 'source-val12', root }, pinned, failInit), 3)
  assert.deepEqual(failing, ['init'], 'a failed init must not proceed to plan')
})

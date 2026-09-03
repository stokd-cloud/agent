#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function parseValidationRequest(raw) {
  const request = JSON.parse(raw)
  if (request.schemaVersion !== '1.0') throw new Error('validation request schemaVersion must be 1.0')
  if (!/^[a-z0-9][a-z0-9.-]{2,80}$/.test(request.requestId ?? '')) throw new Error('validation requestId is invalid')
  if (!['diff', 'deploy'].includes(request.action)) throw new Error('validation action must be diff or deploy')
  const phases = {
    'source-data': { stage: 'source-val12', component: 'data', scenario: 'migrate' },
    'source-api-proof': { stage: 'source-val12', component: 'api', scenario: 'source-proof' },
    'restore-data': { stage: 'restore-val12', component: 'data', scenario: 'migrate' },
    'restore-api-proof': { stage: 'restore-val12', component: 'api', scenario: 'restore-proof' },
    'source-data-redeploy': { stage: 'source-val12', component: 'data', scenario: 'migrate-and-redeploy-proof' },
    'source-api-redeploy': { stage: 'source-val12', component: 'api', scenario: 'redeploy-proof' },
    'restore-data-redeploy': { stage: 'restore-val12', component: 'data', scenario: 'migrate-and-redeploy-proof' },
    'restore-api-redeploy': { stage: 'restore-val12', component: 'api', scenario: 'redeploy-proof' },
  }
  if (typeof request.phase !== 'string' || !phases[request.phase]) throw new Error('validation request phase is unsupported')
  if (Object.keys(request).sort().join(',') !== 'action,phase,requestId,schemaVersion') throw new Error('validation request has unknown fields')
  return { ...request, ...phases[request.phase] }
}

export function run(argv = process.argv.slice(2), environment = process.env) {
  if (environment.GITHUB_EVENT_NAME === 'push' && environment.GITHUB_REF !== 'refs/heads/project/d7f02e6-cloud-agents-mvp') {
    throw new Error('branch-native validation is restricted to project/d7f02e6-cloud-agents-mvp')
  }
  let raw
  if (argv.length === 0) raw = readFileSync(resolve(root, 'infra/validation-request.json'), 'utf8')
  else {
    if (argv.length !== 6 || argv[0] !== '--phase' || argv[2] !== '--action' || argv[4] !== '--request-id') throw new Error('manual validation request arguments are invalid')
    raw = JSON.stringify({ schemaVersion: '1.0', phase: argv[1], action: argv[3], requestId: argv[5] })
  }
  const request = parseValidationRequest(raw)
  const output = environment.GITHUB_OUTPUT
  if (!output) throw new Error('GITHUB_OUTPUT is required')
  appendFileSync(output, `action=${request.action}\n`)
  appendFileSync(output, `stage=${request.stage}\n`)
  appendFileSync(output, `component=${request.component}\n`)
  appendFileSync(output, `phase=${request.phase}\n`)
  appendFileSync(output, `scenario=${request.scenario}\n`)
  appendFileSync(output, `request_id=${request.requestId}\n`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run() }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2 }
}

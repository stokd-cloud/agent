import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createAgentHttpServer } from '../workspace/apps/api/lib/index.js'
import { createUnsupportedApplicationService } from '../workspace/packages/runtime/lib/index.js'

const port = Number(process.env.PORT ?? '8080')
const recoveryMode = process.env.AGENT_RECOVERY_MODE
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT is invalid')
if (!['active', 'restored_observation'].includes(recoveryMode)) throw new Error('AGENT_RECOVERY_MODE must be active or restored_observation')

const readinessEnvironment = {
  ...process.env,
  AGENT_MAINTENANCE_CONFIG: '/run/stokd-agent/readiness-config.json',
  AGENT_CREDENTIAL_FILE: '/run/stokd-agent/runtime-credential.json',
  AGENT_OUTPUT_PATH: '/run/stokd-agent/readiness-output.json',
}
delete readinessEnvironment.AGENT_RUNTIME_SECRET_VALUE
const validationOperationId = 'valop_work12_durable_fixture'
const validationPayload = createHash('sha256').update('stokd-agent/cloud-agents-mvp/fixed-validation-fixture/v1').digest()
const validationPayloadSha256 = createHash('sha256').update(validationPayload).digest('hex')
const validationReadEnvironment = {
  ...readinessEnvironment,
  AGENT_MAINTENANCE_CONFIG: '/run/stokd-agent/validation-read-config.json',
  AGENT_OUTPUT_PATH: '/run/stokd-agent/validation-read-output.json',
}
writeFileSync(validationReadEnvironment.AGENT_MAINTENANCE_CONFIG, JSON.stringify({
  schemaVersion: '1.0', command: 'validation-read', environment: process.env.AGENT_STAGE,
  databaseName: process.env.AGENT_DATABASE_NAME, replicaSet: process.env.AGENT_REPLICA_SET,
  mongoHost: process.env.AGENT_MONGO_HOST, operationId: validationOperationId,
  expectedPayloadSha256: validationPayloadSha256,
}), { mode: 0o400 })
let readiness
let readinessAt = 0

function runReadiness() {
  const result = spawnSync('/usr/local/bin/stokd-agent-storage-maintenance', ['readiness'], {
    env: readinessEnvironment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 25_000,
  })
  if (result.status !== 0) throw new Error('Agent storage readiness failed')
  const envelope = JSON.parse(readFileSync(readinessEnvironment.AGENT_OUTPUT_PATH, 'utf8'))
  if (envelope?.schemaVersion !== '1.0' || envelope?.command !== 'readiness' || envelope?.ok !== true) throw new Error('Agent storage readiness output is invalid')
  readiness = envelope.result
  readinessAt = Date.now()
  return readiness
}

function runValidationRead() {
  const result = spawnSync('/usr/local/bin/stokd-agent-storage-maintenance', ['validation-read'], {
    env: validationReadEnvironment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 25_000,
  })
  if (result.status !== 0) throw new Error('fixed Agent validation fixture read failed')
  const envelope = JSON.parse(readFileSync(validationReadEnvironment.AGENT_OUTPUT_PATH, 'utf8'))
  if (envelope?.schemaVersion !== '1.0' || envelope?.command !== 'validation-read' || envelope?.ok !== true || envelope?.result?.operationId !== validationOperationId || envelope?.result?.payloadSha256 !== validationPayloadSha256 || envelope?.result?.payloadByteLength !== 32) {
    throw new Error('fixed Agent validation fixture readback is invalid')
  }
  return envelope.result
}

runReadiness()

const unsupportedService = createUnsupportedApplicationService()
const service = {
  ...unsupportedService,
  // The command contract is live in this MVP; durable event production begins
  // with the executor lifecycle. An empty stream is still served by the real
  // versioned SSE transport and never invents state-changing events.
  async *events() {},
}
const server = createAgentHttpServer(service)
const [agentRequestHandler] = server.listeners('request')
if (typeof agentRequestHandler !== 'function' || server.listenerCount('request') !== 1) throw new Error('Agent API transport request boundary changed')
server.removeAllListeners('request')
server.on('request', (request, response) => {
  const url = new URL(request.url ?? '/', 'http://agent.invalid')
  if (request.method === 'GET' && url.pathname === '/health') {
    try {
      if (Date.now() - readinessAt > 5_000) runReadiness()
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true, service: 'stokd-agent-api', recoveryMode, storage: readiness }))
    } catch {
      response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: false, service: 'stokd-agent-api', recoveryMode, error: 'storage_not_ready' }))
    }
    return
  }
  if (request.method === 'GET' && url.pathname === '/v1/validation-fixture') {
    try {
      const fixture = runValidationRead()
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true, recoveryMode, fixture }))
    } catch {
      response.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: false, recoveryMode, error: 'fixed_validation_fixture_not_found' }))
    }
    return
  }
  if (request.method !== 'GET' && recoveryMode === 'restored_observation') {
    response.writeHead(423, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ ok: false, error: 'restored_observation_only' }))
    return
  }
  return agentRequestHandler.call(server, request, response)
})

server.listen(port, '0.0.0.0')

function stop() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

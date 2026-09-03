import { existsSync, writeFileSync } from 'node:fs'
import { openAgentStorage } from '../../../packages/storage/lib/index.js'

const required = name => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const marker = required('AGENT_MIGRATION_MARKER')
const releaseMarker = process.env.AGENT_MIGRATION_RELEASE_MARKER
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const storage = await openAgentStorage({
  uri: required('AGENT_MIGRATION_URI'),
  environment: required('AGENT_MIGRATION_ENVIRONMENT'),
  expectedReplicaSet: required('AGENT_MIGRATION_REPLICA_SET'),
  principal: 'migration',
}, {
  migrate: true,
  transactionProbe: false,
  migration: {
    leaseDurationMS: 300,
    async onStep(step, stepNumber) {
      if (stepNumber !== 4) return
      writeFileSync(marker, JSON.stringify({ pid: process.pid, step, stepNumber }))
      if (!releaseMarker) await new Promise(() => {})
      while (!existsSync(releaseMarker)) await sleep(20)
    },
  },
})
await storage.close()

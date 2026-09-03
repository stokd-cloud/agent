#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { preflightPhase } from './infra-phase-control.mjs'

function aws(args) {
  const result = spawnSync('aws', [...args, '--region', 'us-east-1'], { encoding: 'utf8', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`AWS ${args[0]} ${args[1]} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout
}
function args(argv) {
  if (![6, 8].includes(argv.length) || argv[0] !== '--phase' || argv[2] !== '--validation-run-id' || argv[4] !== '--source-digest' || (argv.length === 8 && argv[6] !== '--plan-digest')) throw new Error('phase preflight requires exact phase, validation run ID, source digest, and optional plan digest')
  return { phase: argv[1], validationRunId: argv[3], sourceDigest: argv[5], ...(argv.length === 8 ? { planDigest: argv[7] } : {}) }
}

try { process.stdout.write(`${JSON.stringify(preflightPhase({ aws, ...args(process.argv.slice(2)) }))}\n`) }
catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2 }

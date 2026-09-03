#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [stage, ...extra] = process.argv.slice(2)
if (extra.length || !['source-val12', 'restore-val12'].includes(stage)) throw new Error('preview images require exactly one validation stage')
if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required for preview image placeholders')
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
if (git.status !== 0) throw new Error('unable to resolve preview source digest')
const sourceDigest = (process.env.GITHUB_SHA || git.stdout.trim())
if (!/^[a-f0-9]{40}$/.test(sourceDigest) || sourceDigest !== git.stdout.trim()) throw new Error('preview source digest must equal the checked-out commit')
const definitions = [
  ['AGENT_API_IMAGE', 'api', 'infra/docker/api.Dockerfile'],
  ['AGENT_MONGO_IMAGE', 'mongodb', 'infra/docker/mongodb.Dockerfile'],
  ['AGENT_MAINTENANCE_IMAGE', 'maintenance', 'infra/docker/maintenance.Dockerfile'],
]
const output = { schemaVersion: '1.0', kind: 'non-publishable-preview-placeholders', stage, sourceDigest, images: {} }
for (const [name, component, dockerfile] of definitions) {
  const dockerfileDigest = createHash('sha256').update(readFileSync(resolve(root, dockerfile))).digest('hex')
  const digest = createHash('sha256').update(`preview-only\0${sourceDigest}\0${stage}\0${component}\0${dockerfileDigest}`).digest('hex')
  const image = `167217327520.dkr.ecr.us-east-1.amazonaws.com/stokd-agent-runtime@sha256:${digest}`
  appendFileSync(process.env.GITHUB_ENV, `${name}=${image}\n`)
  output.images[component] = image
}
appendFileSync(process.env.GITHUB_ENV, `AGENT_SOURCE_DIGEST=${sourceDigest}\n`)
process.stdout.write(`${JSON.stringify(output)}\n`)

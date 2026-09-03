#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

function parse(raw, label) {
  try { return JSON.parse(raw) }
  catch { throw new Error(`${label} returned invalid JSON`) }
}

export function apiPreviewReadiness({ stage, sourceDigest, aws }) {
  assert(['source-val12', 'restore-val12'].includes(stage), 'API preview stage is invalid')
  assert.match(sourceDigest ?? '', /^[a-f0-9]{40}$/, 'API preview source digest is invalid')
  const name = `/stokd-agent/${stage}/infrastructure-manifest/v1`
  let envelope
  try { envelope = parse(aws(['ssm', 'get-parameter', '--name', name, '--no-with-decryption', '--output', 'json']), `${stage} data manifest`) }
  catch (error) {
    if (/ParameterNotFound/.test(error instanceof Error ? error.message : String(error))) {
      return { schemaVersion: '1.0', stage, ready: false, reason: 'data_manifest_absent', parameterName: name }
    }
    throw error
  }
  const manifest = parse(envelope.Parameter?.Value, `${stage} data manifest value`)
  assert.equal(manifest.schemaVersion, '1.0')
  assert.equal(manifest.manifestVersion, 1)
  assert.equal(manifest.accountId, '167217327520')
  assert.equal(manifest.region, 'us-east-1')
  assert.equal(manifest.stage, stage)
  assert.match(manifest.sourceDigest ?? '', /^[a-f0-9]{40}$/, `${stage} data manifest source digest is invalid`)
  if (manifest.sourceDigest !== sourceDigest) {
    return { schemaVersion: '1.0', stage, ready: false, reason: 'data_manifest_source_digest_mismatch', parameterName: name }
  }
  assert.equal(typeof manifest.vpc?.id, 'string', `${stage} data manifest omitted VPC identity`)
  assert.equal(typeof manifest.cluster?.id, 'string', `${stage} data manifest omitted ECS cluster identity`)
  assert.equal(typeof manifest.custody?.kmsKeyArn, 'string', `${stage} data manifest omitted KMS identity`)
  return { schemaVersion: '1.0', stage, ready: true, reason: 'exact_data_manifest_present', parameterName: name }
}

function aws(args) {
  const result = spawnSync('aws', [...args, '--region', 'us-east-1'], { encoding: 'utf8', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`AWS API preview prerequisite read failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const [stage, ...extra] = process.argv.slice(2)
    if (extra.length) throw new Error('API preview readiness accepts exactly one stage')
    process.stdout.write(`${JSON.stringify(apiPreviewReadiness({ stage, sourceDigest: process.env.GITHUB_SHA, aws }))}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MANIFESTS = [
  'package.json',
  'packages/protocol/package.json',
  'packages/runtime/package.json',
  'packages/dsh/package.json',
  'packages/storage/package.json',
  'packages/stokd-bridge/package.json',
  'apps/api/package.json',
  'apps/host/package.json',
  'apps/cli/package.json',
]

export function verifyPinnedToolchain(root, { requireRuntime = true } = {}) {
  const fixture = JSON.parse(readFileSync(join(root, 'provenance/toolchain.json'), 'utf8'))
  assert.deepEqual(fixture, { schemaVersion: '1.0', node: '24.15.0', pnpm: '11.25.0' }, 'toolchain fixture drift')
  assert.equal(readFileSync(join(root, '.nvmrc'), 'utf8').trim(), fixture.node, '.nvmrc drift')
  assert.equal(readFileSync(join(root, '.node-version'), 'utf8').trim(), fixture.node, '.node-version drift')
  for (const path of MANIFESTS) {
    const manifest = JSON.parse(readFileSync(join(root, path), 'utf8'))
    assert.equal(manifest.engines?.node, fixture.node, `${path} Node pin drift`)
    if (path === 'package.json') assert.equal(manifest.packageManager, `pnpm@${fixture.pnpm}`, 'root pnpm pin drift')
  }
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
  assert.match(workflow, /node-version:\s*24\.15\.0(?:\s|$)/, 'CI Node pin drift')
  assert.match(workflow, /version:\s*11\.25\.0(?:\s|$)/, 'CI pnpm pin drift')
  if (requireRuntime) assert.equal(process.version, `v${fixture.node}`, 'active Node runtime does not match repository pin')
  return { ...fixture, manifests: MANIFESTS }
}

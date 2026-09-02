
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root=process.cwd()
const requested=['packages/protocol/lib/index.js','packages/runtime/lib/index.js','packages/storage/lib/index.js','packages/dsh/lib/index.js','packages/stokd-bridge/lib/index.js','apps/api/lib/index.js','apps/host/lib/index.js','apps/cli/lib/index.js']
for(const entry of requested){await access(join(root,entry));await import(pathToFileURL(join(root,entry)).href)}
assert.ok(!root.includes('/mono/'),'runtime import root must be independent from Mono');assert.equal(process.env.STOKD_BIN,'/definitely/unavailable/stokd')
console.log(JSON.stringify({ok:true,requested}))

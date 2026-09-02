
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ensureRepositoryTarget, inspectRepositoryTarget, RepositoryNameCollisionError } from './lib/repository-target.mjs'
import { verifyPinnedToolchain } from './lib/toolchain.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const manifest=JSON.parse(readFileSync(join(root,'provenance/donor.json'),'utf8'))
const toolchain=verifyPinnedToolchain(root)
function git(args,{cwd=root,allowFailure=false}={}) { const r=spawnSync('git',args,{cwd,encoding:'utf8'}); if(!allowFailure) assert.equal(r.status,0,`${args.join(' ')}: ${r.stderr}`); return r }
function sha(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
assert.equal(git(['merge-base','--is-ancestor',manifest.donor.commit,'HEAD']).status,0)
assert.equal(git(['rev-parse',`${manifest.donor.tag}^{}`]).stdout.trim(),manifest.donor.commit)
assert.equal(git(['rev-parse',manifest.donor.tag]).stdout.trim(),manifest.donor.tagObject)
assert.equal(git(['remote','get-url','origin']).stdout.trim(),manifest.fork.url)
assert.equal(git(['remote','get-url','upstream']).stdout.trim(),manifest.donor.url)
for (const ref of manifest.backupRefs) {
  const candidates=[ref.localName,ref.remoteName]
  let observed=null
  for(const candidate of candidates){const result=git(['rev-parse','--verify',candidate],{allowFailure:true});if(result.status===0){observed=result.stdout.trim();break}}
  if(!observed){const remote=git(['ls-remote','origin',ref.remoteHead],{allowFailure:true});if(remote.status===0&&remote.stdout.trim())observed=remote.stdout.trim().split(/\s+/)[0]}
  assert.equal(observed,ref.commit,`missing preserved backup ref ${ref.remoteHead}`)
}
for (const sub of manifest.submodules) {
  const row=git(['ls-files','-s','--',sub.path]).stdout.trim().split(/\s+/)
  assert.equal(row[0],'160000'); assert.equal(row[1],sub.commit)
  assert.equal(git(['config','-f','.gitmodules','--get',`submodule.${sub.name}.path`]).stdout.trim(),sub.path)
  assert.equal(git(['config','-f','.gitmodules','--get',`submodule.${sub.name}.url`]).stdout.trim(),sub.url)
}
assert.match(readFileSync(join(root,'LICENSE'),'utf8'),/MIT License/)
assert.ok(readFileSync(join(root,'packages/tui/THIRD_PARTY_LICENSES'),'utf8').length>100)
assert.equal(sha(join(root,manifest.donor.lockfile.path)),manifest.donor.lockfile.sha256)
function dshOverrides(path){const lines=readFileSync(path,'utf8').split(/\r?\n/);const start=lines.findIndex(line=>line==='overrides:');assert.ok(start>=0,`missing overrides in ${path}`);const entries=[];for(const line of lines.slice(start+1)){if(line.length>0&&!line.startsWith(' '))break;const match=/^  ['\"]?(@deepseek-ai\/dsh-[^'\":]+)['\"]?:\s+([^\s#]+)/.exec(line);if(match)entries.push([match[1],match[2].replace(/^['\"]|['\"]$/g,'')])}assert.ok(entries.length>0,`missing DSH overrides in ${path}`);return new Map(entries)}
const pinned=manifest.dsh.version;assert.equal(pinned,'0.1.1-rc.2');const workspaceOverrides=dshOverrides(join(root,'pnpm-workspace.yaml'));const lockOverrides=dshOverrides(join(root,'pnpm-lock.yaml'));assert.deepEqual([...lockOverrides.keys()],[...workspaceOverrides.keys()]);for(const [name,version] of workspaceOverrides){assert.equal(version,pinned,`${name} workspace override drift`);assert.equal(lockOverrides.get(name),pinned,`${name} lock override drift`);assert.ok(readFileSync(join(root,'pnpm-lock.yaml'),'utf8').includes(`'${name}@${pinned}'`),`${name} has no resolved ${pinned} lock entry`)}
const inventory=inspectRepositoryTarget({repoPath:root,expectedOrigin:manifest.fork.url,expectedUpstream:manifest.donor.url})
assert.equal(inventory.status,'existing-authorized-fork')
const collision=mkdtempSync(join(tmpdir(),'agent-repo-collision-'))
const bootstrap=mkdtempSync(join(tmpdir(),'agent-repo-bootstrap-'))
try {
  assert.equal(git(['init','-q',collision]).status,0)
  assert.equal(git(['-C',collision,'remote','add','origin','https://github.com/unrelated/collision.git']).status,0)
  assert.equal(git(['-C',collision,'remote','add','upstream',manifest.donor.url]).status,0)
  const before=readFileSync(join(collision,'.git/config'))
  assert.throws(()=>ensureRepositoryTarget({repoPath:collision,expectedOrigin:manifest.fork.url,expectedUpstream:manifest.donor.url,bootstrapUpstream:true}),RepositoryNameCollisionError)
  assert.deepEqual(readFileSync(join(collision,'.git/config')),before)
  assert.equal(git(['init','-q',bootstrap]).status,0)
  assert.equal(git(['-C',bootstrap,'remote','add','origin',manifest.fork.url]).status,0)
  const restored=ensureRepositoryTarget({repoPath:bootstrap,expectedOrigin:manifest.fork.url,expectedUpstream:manifest.donor.url,bootstrapUpstream:true})
  assert.equal(restored.status,'existing-authorized-fork');assert.equal(git(['-C',bootstrap,'remote','get-url','upstream']).stdout.trim(),manifest.donor.url)
} finally { rmSync(collision,{recursive:true,force:true});rmSync(bootstrap,{recursive:true,force:true}) }
console.log(JSON.stringify({ok:true,inventory,toolchain,donorCommit:manifest.donor.commit,collisionRefused:true,upstreamBootstrap:'idempotent-and-explicit',noticesPreserved:true,dshPin:pinned,dshOverrides:workspaceOverrides.size}))

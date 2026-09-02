
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root=resolve('.');const dir=mkdtempSync(join(tmpdir(),'agent-import-trace-'));const network=join(dir,'network.json');const probeNetwork=join(dir,'network-probe.json');const modules=join(dir,'modules.txt');writeFileSync(modules,'')
try{
 const result=spawnSync(process.execPath,['--experimental-loader','./tests/work-1.1/module-trace-loader.mjs','--import','./tests/work-1.1/network-guard.mjs','./tests/work-1.1/import-targets.mjs'],{cwd:root,encoding:'utf8',env:{...process.env,AGENT_NETWORK_TRACE:network,AGENT_MODULE_TRACE:modules,STOKD_BIN:'/definitely/unavailable/stokd',STOKD_API_URL:'http://127.0.0.1:1',MONGODB_URI:''}})
 assert.equal(result.status,0,result.stderr);const attempted=JSON.parse(readFileSync(network,'utf8'));assert.deepEqual(attempted,[])
 const loaded=[...new Set(readFileSync(modules,'utf8').trim().split('\n').filter(Boolean).map(fileURLToPath))]
 assert.ok(loaded.every(path=>!path.includes('/packages/tui/')));assert.ok(loaded.every(path=>!path.includes('/mono/')));const product=loaded.filter(path=>path.startsWith(root));assert.ok(product.length>=8);assert.ok(product.every(path=>!path.includes('/src/')))
 const probe=spawnSync(process.execPath,['--import','./tests/work-1.1/network-guard.mjs','./tests/work-1.1/network-guard-probe.mjs'],{cwd:root,encoding:'utf8',env:{...process.env,AGENT_NETWORK_TRACE:probeNetwork}});assert.equal(probe.status,0,probe.stderr);const guardTrace=JSON.parse(readFileSync(probeNetwork,'utf8'));const kinds=new Set(guardTrace.map(entry=>entry.kind));for(const kind of ['dns.promises.lookup','dns.promises.resolve','dgram.createSocket','net.connect','fetch'])assert.ok(kinds.has(kind),`network guard probe missed ${kind}`);assert.ok([...kinds].some(kind=>kind.startsWith('net.')||kind.startsWith('tls.')),'HTTP/S did not funnel through socket guard')
 console.log(JSON.stringify({ok:true,importAttemptedNetwork:attempted,networkGuardKinds:[...kinds].sort(),httpAndHttpsDenied:true,loadedProductModules:product.map(path=>path.slice(root.length+1)),tuiLoaded:false,siblingSourceLoaded:false}))
}finally{rmSync(dir,{recursive:true,force:true})}

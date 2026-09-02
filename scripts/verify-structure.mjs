
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, requireValue } from './lib/args.mjs'
import { validateStructureScenarioLinks, validateWorkScenarioMapping } from './lib/scenario-mapping.mjs'
import { computeBuildFingerprint } from './lib/build-fingerprint.mjs'
import { verifyPinnedToolchain } from './lib/toolchain.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
function stable(value) { if(Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if(value&&typeof value==='object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`; return JSON.stringify(value) }
function sha(value) { return createHash('sha256').update(stable(value)).digest('hex') }
function files(dir) { return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]) }
try {
  if(process.env.AGENT_ALLOW_MOCKS || process.env.AGENT_MOCK_MODE) throw new Error('mock substitution is forbidden')
  if(process.env.AGENT_STRUCTURE_SETUP==='missing') throw new Error('required structure setup is missing')
  const args=parseArgs(process.argv.slice(2)); const item=requireValue(args,'item')
  if(process.env.AGENT_STRUCTURE_MANIFEST)throw new Error('AGENT_STRUCTURE_MANIFEST override is forbidden');if(process.env.AGENT_BUILD_FINGERPRINT)throw new Error('AGENT_BUILD_FINGERPRINT override is forbidden')
  const manifestPath=join(root,'tests/verification/items.json');assert.equal(createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),'c862fe81ed46191d33163cccbb1d8c4a9c7d79dfba12012fcb62d353943f8952','canonical structure manifest drift');assert.equal(createHash('sha256').update(readFileSync(join(root,'tests/verification/work-items.json'))).digest('hex'),'aae8ce5bf73dca6f3c5e849c4b88744c60834f7716446911c2a0515e9627d602','canonical work manifest drift')
  const toolchain=verifyPinnedToolchain(root);const registry=JSON.parse(readFileSync(manifestPath,'utf8')); const entry=registry.items?.[item]
  if(!entry) throw new Error(`unknown structure item: ${item}`)
  if(!Array.isArray(entry.scenarios)||entry.scenarios.length===0) throw new Error(`empty structure scenario selection: ${item}`)
  const contracts=JSON.parse(readFileSync(join(root,'tests/contracts/targets.json'),'utf8'));const workRegistry=JSON.parse(readFileSync(join(root,'tests/verification/work-items.json'),'utf8'));const workEntry=workRegistry.items?.[item];if(!workEntry)throw new Error(`missing work manifest for ${item}`);const coverage=validateWorkScenarioMapping(contracts,item,workEntry);const structureLinks=validateStructureScenarioLinks(entry,workEntry)
  const buildFingerprintPath=join(root,'tests/verification/build-fingerprint.json');assert.equal(createHash('sha256').update(readFileSync(buildFingerprintPath)).digest('hex'),'4da60bbd6c108b32de64463d52eaefde44546b4ede085e64adcbac8461d4a1fd','canonical build fingerprint manifest drift');const expectedBuild=JSON.parse(readFileSync(buildFingerprintPath,'utf8'));const actualBuild=computeBuildFingerprint(root);assert.deepEqual(actualBuild,expectedBuild,'build/source fingerprint mismatch')
  const required=['packages/protocol','packages/runtime','packages/dsh','packages/storage','packages/tui','packages/stokd-bridge','apps/api','apps/host','apps/cli','infra','tests']
  for(const rel of required) assert.ok(statSync(join(root,rel)).isDirectory(),`missing ${rel}`)
  const names={
    'packages/protocol':'@stokd-cloud/agent-protocol','packages/runtime':'@stokd-cloud/agent-runtime','packages/dsh':'@stokd-cloud/agent-dsh',
    'packages/storage':'@stokd-cloud/agent-storage','packages/stokd-bridge':'@stokd-cloud/agent-stokd-bridge','apps/api':'@stokd-cloud/agent-api',
    'apps/host':'@stokd-cloud/agent-host','apps/cli':'@stokd-cloud/agent-cli',
  }
  for(const [rel,name] of Object.entries(names)) assert.equal(JSON.parse(readFileSync(join(root,rel,'package.json'),'utf8')).name,name)
  const schemaNames=readdirSync(join(root,'packages/protocol/schemas/v1')).sort()
  assert.deepEqual(schemaNames,['artifact.schema.json','authority.schema.json','command.schema.json','context.schema.json','error.schema.json','event.schema.json','host-capabilities.schema.json','ids.schema.json','work-receipt.schema.json'])
  for(const name of schemaNames) {const schema=JSON.parse(readFileSync(join(root,'packages/protocol/schemas/v1',name),'utf8'));assert.equal(schema.$schema,'https://json-schema.org/draft/2020-12/schema');const visit=(value,path='$')=>{if(value&&typeof value==='object'){if(!Array.isArray(value)&&Object.keys(value).length===0)throw new Error(`placeholder schema object: ${name}:${path}`);for(const [key,child] of Object.entries(value))visit(child,`${path}.${key}`)}};visit(schema)}
  const commandSchema=JSON.parse(readFileSync(join(root,'packages/protocol/schemas/v1/command.schema.json'),'utf8'));assert.equal(commandSchema.oneOf?.length,5);assert.deepEqual(commandSchema.oneOf.map(x=>x.properties.commandType.const).sort(),['approval.respond','artifact.reference.get','conversation.message.admit','wake.cancel','wake.status.get'])
  const schemaManifest=JSON.parse(readFileSync(join(root,'packages/protocol/schemas/manifest.json'),'utf8'));assert.deepEqual(schemaManifest.schemas.map(entry=>entry.path).sort(),schemaNames.map(name=>`v1/${name}`).sort());for(const entry of schemaManifest.schemas)assert.equal(createHash('sha256').update(readFileSync(join(root,'packages/protocol/schemas',entry.path))).digest('hex'),entry.sha256,`protocol schema drift: ${entry.path}`)
  const boundaryRoots=['packages/runtime/src','packages/dsh/src','packages/storage/src','packages/stokd-bridge/src','apps/api/src','apps/host/src','apps/cli/src']
  const forbidden=[/packages\/tui/,/@deepseek-harness-tui/,/stokd-cloud\/mono/,/@stokd-cloud\/(?:db|database|api-client)/,/stokd[^\n]*database[^\n]*client/i]
  for(const rel of boundaryRoots) for(const path of files(join(root,rel))) {
    const source=readFileSync(path,'utf8'); for(const pattern of forbidden) assert.ok(!pattern.test(source),`${rel} crosses forbidden boundary: ${pattern}`)
  }
  assert.match(readFileSync(join(root,'packages/tui/src/cloud-agent-client.ts'),'utf8'),/@stokd-cloud\/agent-protocol/)
  assert.equal(sha(contracts),'e222ab2b36ca45484ec4ffef25cb25f15574e2272ad50d259e9b057b2b2db660'); assert.equal(contracts.targets.length,103)
  assert.deepEqual(contracts.familyCounts,{AGENT:5,APPROVAL:2,AUTH:6,BRIDGE:6,CLI:7,CROSS:3,CTX:6,FILE:9,IMPORT:8,MEM:6,OPS:7,POLICY:5,REPO:5,RUN:11,TUI:10,WORK:7})
  const ledger=JSON.parse(readFileSync(join(root,'tests/donor/case-ledger.json'),'utf8')); assert.equal(sha(ledger),'0dddd7a01fbf1ee38473c6fb113ac3650c6bde1a2ef883be283d1b5a1c9c6b10'); assert.equal(ledger.cases.length,112)
  const oracles=JSON.parse(readFileSync(join(root,'tests/oracles/manifest.json'),'utf8')); assert.ok(oracles.files.length>=6)
  for(const file of oracles.files){const bytes=readFileSync(join(root,'tests/oracles',file.path));assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,`oracle drift: ${file.path}`);assert.ok(bytes.length>200,`oracle is empty or placeholder: ${file.path}`)}
  const protocol=await import(pathToFileURL(join(root,'packages/protocol/lib/index.js')).href)
  assert.throws(()=>protocol.assertSupportedMajor('2.0'),e=>e.envelope?.exitCode===7)
  const base={schemaVersion:'1.4',eventId:'evt_12345678',sequence:9,agentId:'agt_12345678',conversationId:'cnv_12345678',wakeId:'wak_12345678',attemptId:'atm_12345678',occurredAt:'2026-09-01T00:00:00Z',payload:{}}
  assert.deepEqual(protocol.decodeAgentEvent({...base,eventType:'telemetry.future',stateChanging:false}).stateChanged,false)
  assert.throws(()=>protocol.decodeAgentEvent({...base,eventType:'state.future',stateChanging:true}),e=>e.envelope?.exitCode===7)
  console.log(JSON.stringify({ok:true,item,toolchain,scenarios:entry.scenarios,coverage,structureLinks,packages:Object.keys(names),schemas:schemaNames.length,contracts:103,donorCases:112,buildFingerprint:{sourceSha256:actualBuild.sourceSha256,outputSha256:actualBuild.outputSha256}}))
} catch(error) { console.error(error instanceof Error?error.stack||error.message:String(error)); process.exitCode=2 }

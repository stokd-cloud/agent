
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
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
  const manifestPath=join(root,'tests/verification/items.json');assert.equal(createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),'a02a4b4f47a71f4b59ce6c6ad9e353d32ac85d9e32dd099d81dbf3f4f474e6c2','canonical structure manifest drift');assert.equal(createHash('sha256').update(readFileSync(join(root,'tests/verification/work-items.json'))).digest('hex'),'17f9f765aa84faf2629760edab6cbcb62fc87a5dcf5977739120534a5b07a318','canonical work manifest drift')
  const toolchain=verifyPinnedToolchain(root);const registry=JSON.parse(readFileSync(manifestPath,'utf8')); const entry=registry.items?.[item]
  if(!entry) throw new Error(`unknown structure item: ${item}`)
  if(!Array.isArray(entry.scenarios)||entry.scenarios.length===0) throw new Error(`empty structure scenario selection: ${item}`)
  const contracts=JSON.parse(readFileSync(join(root,'tests/contracts/targets.json'),'utf8'));const workRegistry=JSON.parse(readFileSync(join(root,'tests/verification/work-items.json'),'utf8'));const workEntry=workRegistry.items?.[item];if(!workEntry)throw new Error(`missing work manifest for ${item}`);const coverage=validateWorkScenarioMapping(contracts,item,workEntry);const structureLinks=validateStructureScenarioLinks(entry,workEntry)
  const itemStructureScripts=item==='1.2'?['tests/structure-1.2/storage-boundaries.mjs','tests/structure-1.2/terraform-substrate.mjs','tests/work-1.2/infra-terraform-executor.mjs','tests/work-1.2/infra-policy-structure.mjs','tests/work-1.2/infra-guard-negative.mjs','tests/work-1.2/infra-mongo-cleanup.mjs','tests/work-1.2/infra-cloud-lifecycle.mjs']:[]
  for(const script of itemStructureScripts){const path=join(root,script);assert.ok(lstatSync(path).isFile(),`missing or non-regular item structure script: ${script}`);const canonical=realpathSync(path);const rel=relative(realpathSync(join(root,'tests')),canonical);assert.ok(rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`),`item structure script escapes tests: ${script}`);const child=spawnSync(process.execPath,[canonical],{cwd:root,encoding:'utf8',env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''}});if(child.status!==0)throw new Error(`item structure script failed: ${script}\n${child.stdout}\n${child.stderr}`)}
  const buildFingerprintPath=join(root,'tests/verification/build-fingerprint.json');assert.equal(createHash('sha256').update(readFileSync(buildFingerprintPath)).digest('hex'),'8b537485866732ff9c887a131b68e0080212d2d3b20932b0589a0d0a17890b05','canonical build fingerprint manifest drift');const expectedBuild=JSON.parse(readFileSync(buildFingerprintPath,'utf8'));const actualBuild=computeBuildFingerprint(root);assert.deepEqual(actualBuild,expectedBuild,'build/source fingerprint mismatch')
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
  assert.equal(sha(contracts),'81d82ac2d5224f1c485d45c684b90ea23326cc75bc6d373ef72e35283ff10d08'); assert.equal(contracts.targets.length,103)
  assert.deepEqual(contracts.familyCounts,{AGENT:5,APPROVAL:2,AUTH:6,BRIDGE:6,CLI:7,CROSS:3,CTX:6,FILE:9,IMPORT:8,MEM:6,OPS:7,POLICY:5,REPO:5,RUN:11,TUI:10,WORK:7})
  const ledger=JSON.parse(readFileSync(join(root,'tests/donor/case-ledger.json'),'utf8')); assert.equal(sha(ledger),'0dddd7a01fbf1ee38473c6fb113ac3650c6bde1a2ef883be283d1b5a1c9c6b10'); assert.equal(ledger.cases.length,112)
  const oracles=JSON.parse(readFileSync(join(root,'tests/oracles/manifest.json'),'utf8')); assert.ok(oracles.files.length>=6)
  for(const file of oracles.files){const bytes=readFileSync(join(root,'tests/oracles',file.path));assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,`oracle drift: ${file.path}`);assert.ok(bytes.length>200,`oracle is empty or placeholder: ${file.path}`)}
  const protocol=await import(pathToFileURL(join(root,'packages/protocol/lib/index.js')).href)
  assert.throws(()=>protocol.assertSupportedMajor('2.0'),e=>e.envelope?.exitCode===7)
  const base={schemaVersion:'1.4',eventId:'evt_12345678',sequence:9,agentId:'agt_12345678',conversationId:'cnv_12345678',wakeId:'wak_12345678',attemptId:'atm_12345678',occurredAt:'2026-09-01T00:00:00Z',payload:{}}
  assert.deepEqual(protocol.decodeAgentEvent({...base,eventType:'telemetry.future',stateChanging:false}).stateChanged,false)
  assert.throws(()=>protocol.decodeAgentEvent({...base,eventType:'state.future',stateChanging:true}),e=>e.envelope?.exitCode===7)
  console.log(JSON.stringify({ok:true,item,toolchain,scenarios:entry.scenarios,coverage,structureLinks,itemStructureScripts,packages:Object.keys(names),schemas:schemaNames.length,contracts:103,donorCases:112,buildFingerprint:{sourceSha256:actualBuild.sourceSha256,outputSha256:actualBuild.outputSha256}}))
} catch(error) { console.error(error instanceof Error?error.stack||error.message:String(error)); process.exitCode=2 }

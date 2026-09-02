
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createUnsupportedApplicationService, createHeadlessAgentClient, startAgentRuntime } from '../../packages/runtime/lib/index.js'
import { openAgentStorage } from '../../packages/storage/lib/index.js'
import { createFreshDshHandle } from '../../packages/dsh/lib/index.js'
import { connectStokdFactoryBridge } from '../../packages/stokd-bridge/lib/index.js'
import { startHostSupervisor, runHost } from '../../apps/host/lib/index.js'
import { runApi } from '../../apps/api/lib/index.js'
import { runCli } from '../../apps/cli/lib/index.js'
const base={schemaVersion:'1.0',agentId:'agt_12345678',conversationId:'cnv_12345678'}
const commands=[
 {...base,commandId:'cmd_00000001',commandType:'conversation.message.admit',expectedRevision:1,payload:{text:'hello',idempotencyKey:'one'}},
 {...base,commandId:'cmd_00000002',commandType:'wake.status.get',payload:{wakeId:'wak_12345678'}},
 {...base,commandId:'cmd_00000003',commandType:'wake.cancel',expectedRevision:1,payload:{wakeId:'wak_12345678'}},
 {...base,commandId:'cmd_00000004',commandType:'approval.respond',expectedRevision:1,payload:{approvalId:'apr_12345678',actionHash:'x',decision:'denied'}},
 {...base,commandId:'cmd_00000005',commandType:'artifact.reference.get',payload:{artifactId:'art_12345678'}},
]
const client=createHeadlessAgentClient(createUnsupportedApplicationService())
const methods=['admitMessage','getWakeStatus','cancelWake','respondApproval','getArtifactReference']
for(let i=0;i<commands.length;i+=1){const result=await client[methods[i]](commands[i]);assert.equal(result.ok,false);assert.equal(result.error.exitCode,7)}
await assert.rejects(openAgentStorage(),e=>e.envelope?.exitCode===7)
await assert.rejects(createFreshDshHandle({agentId:'agt_12345678',wakeId:'wak_12345678',attemptId:'atm_12345678'}),e=>e.envelope?.exitCode===7)
await assert.rejects(connectStokdFactoryBridge(),e=>e.envelope?.exitCode===7)
assert.equal((await startHostSupervisor()).error.exitCode,7)
assert.equal(await startAgentRuntime(),7);let hostDiagnostic='';let apiDiagnostic='';assert.equal(await runHost([],{stderr:{write(v){hostDiagnostic+=v}}}),7);assert.equal(await runApi({stderr:{write(v){apiDiagnostic+=v}}}),7);for(const diagnostic of [hostDiagnostic,apiDiagnostic]){const value=JSON.parse(diagnostic);assert.equal(value.schemaVersion,'1.0');assert.equal(value.error.exitCode,7);assert.equal(value.error.code,'unsupported_capability')}
let stderr='';assert.equal(await runCli(['create','Ada'],{stdout:{write(){}},stderr:{write(v){stderr+=v}}}),7);assert.match(stderr,/unsupported_capability/)
for(const entry of ['apps/cli/lib/bin.js','apps/host/lib/bin.js','apps/api/lib/bin.js']){
 const result=spawnSync(process.execPath,[entry,'unsupported'],{encoding:'utf8'});assert.equal(result.status,7,entry);const value=JSON.parse(result.stderr);assert.equal(value.schemaVersion,'1.0');assert.equal(value.error.exitCode,7);assert.equal(value.error.code,'unsupported_capability')
}
console.log(JSON.stringify({ok:true,operations:methods,entrypoints:['runtime','storage','dsh','stokd-bridge','api','host','cli'],exitCode:7,donorFallback:false}))

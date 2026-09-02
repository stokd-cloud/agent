import assert from 'node:assert/strict'
import { once } from 'node:events'
import { AGENT_JSON_CONTENT_TYPE, AgentProtocolError, createAgentApplicationService, createInProcessAgentClient, decodeAgentCommand, decodeAgentEvent, decodeIpcCommand, deserializeSseEvent, encodeIpcCommand, serializeHttpsCommand, serializeSseEvent } from '../../packages/protocol/lib/index.js'
import { createHeadlessAgentClient } from '../../packages/runtime/lib/index.js'
import { createAgentHttpServer } from '../../apps/api/lib/index.js'
const base={schemaVersion:'1.0',agentId:'agt_12345678',conversationId:'cnv_12345678'}
const commands=[
 {...base,commandId:'cmd_00000001',commandType:'conversation.message.admit',expectedRevision:1,payload:{text:'hello',idempotencyKey:'ingress-1'}},
 {...base,commandId:'cmd_00000002',commandType:'wake.status.get',payload:{wakeId:'wak_12345678'}},
 {...base,commandId:'cmd_00000003',commandType:'wake.cancel',expectedRevision:1,payload:{wakeId:'wak_12345678',reason:'owner request'}},
 {...base,commandId:'cmd_00000004',commandType:'approval.respond',expectedRevision:1,payload:{approvalId:'apr_12345678',actionHash:'sha256:abc',decision:'approved'}},
 {...base,commandId:'cmd_00000005',commandType:'artifact.reference.get',payload:{artifactId:'art_12345678',versionId:'arv_12345678'}},
]
const event={schemaVersion:'1.0',eventId:'evt_12345678',sequence:1,agentId:base.agentId,conversationId:base.conversationId,wakeId:'wak_12345678',attemptId:'atm_12345678',eventType:'wake.queued',stateChanging:true,occurredAt:'2026-09-01T00:00:00Z',payload:{reason:'message'}}
const seen=[];const success=(command,operation)=>Promise.resolve({schemaVersion:'1.0',commandId:command.commandId,ok:true,result:{operation}})
const service=createAgentApplicationService({admitMessage:c=>success(c,'admit'),getWakeStatus:c=>success(c,'status'),cancelWake:c=>success(c,'cancel'),respondApproval:c=>success(c,'approve'),getArtifactReference:c=>success(c,'artifact-reference')},async function*(){seen.push('events');yield event})
const clients=[createInProcessAgentClient(service),createHeadlessAgentClient(service)];const methods=['admitMessage','getWakeStatus','cancelWake','respondApproval','getArtifactReference']
for(const client of clients)for(let i=0;i<commands.length;i+=1){const response=await client[methods[i]](commands[i]);assert.equal(response.ok,true);assert.equal(response.commandId,commands[i].commandId)}
for(const command of commands){assert.deepEqual(decodeIpcCommand(encodeIpcCommand(command)),command);const wire=serializeHttpsCommand(command);assert.equal(wire.contentType,AGENT_JSON_CONTENT_TYPE);assert.deepEqual(decodeAgentCommand(JSON.parse(wire.body)),command)}
assert.deepEqual(deserializeSseEvent(serializeSseEvent(event)),event)
assert.throws(()=>decodeAgentCommand({...commands[0],schemaVersion:'2.0'}),error=>error instanceof AgentProtocolError&&error.envelope.exitCode===7)
assert.throws(()=>decodeAgentCommand({...commands[0],commandType:'shell.run'}),error=>error instanceof AgentProtocolError&&error.envelope.exitCode===7)
assert.throws(()=>decodeAgentCommand({...commands[0],payload:{text:'missing idempotency'}}),error=>error instanceof AgentProtocolError&&error.envelope.exitCode===2)
const informational=decodeAgentEvent({...event,schemaVersion:'1.9',eventType:'telemetry.future',stateChanging:false});assert.equal(informational.stateChanged,false)
assert.throws(()=>decodeAgentEvent({...event,schemaVersion:'1.9',eventType:'state.future',stateChanging:true}),error=>error instanceof AgentProtocolError&&error.envelope.exitCode===7)
const server=createAgentHttpServer(service);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`
try{
 for(const command of commands){const response=await fetch(`${origin}/v1/commands`,{method:'POST',headers:{'content-type':AGENT_JSON_CONTENT_TYPE},body:JSON.stringify(command)});assert.equal(response.status,200);const value=await response.json();assert.equal(value.ok,true);assert.equal(value.commandId,command.commandId)}
 for(const invalid of [{value:{...commands[0],schemaVersion:'2.0'},status:422,exitCode:7},{value:{...commands[0],commandType:'shell.run'},status:422,exitCode:7},{value:{...commands[0],payload:{text:'missing idempotency'}},status:400,exitCode:2}]){const response=await fetch(`${origin}/v1/commands`,{method:'POST',headers:{'content-type':AGENT_JSON_CONTENT_TYPE},body:JSON.stringify(invalid.value)});assert.equal(response.status,invalid.status);assert.equal(response.headers.get('content-type'),AGENT_JSON_CONTENT_TYPE);const value=await response.json();assert.equal(value.ok,false);assert.equal(value.commandId,invalid.value.commandId);assert.equal(value.error.exitCode,invalid.exitCode);assert.equal(value.error.schemaVersion,'1.0')}
 const stream=await fetch(`${origin}/v1/events?agentId=${base.agentId}&conversationId=${base.conversationId}`);assert.equal(stream.status,200);assert.match(stream.headers.get('content-type')??'',/^text\/event-stream/);assert.deepEqual(deserializeSseEvent(await stream.text()),event)
}finally{await new Promise(resolve=>server.close(resolve))}
assert.ok(seen.length>=1);console.log(JSON.stringify({ok:true,inProcessClients:2,operations:methods,rawHttpCommands:5,rawHttpErrors:[7,7,2],sseEvents:1,networkTrace:[origin],unsupportedMajor:'exit-7',unknownMinorInformational:'skipped-without-state-change',unknownStateChanging:'exit-7'}))

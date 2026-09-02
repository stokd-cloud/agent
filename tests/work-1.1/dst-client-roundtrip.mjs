import assert from 'node:assert/strict'
import { createAgentApplicationService, createInProcessAgentClient } from '../../packages/protocol/lib/index.js'
import { createDstCloudAgentClient } from '../../packages/tui/lib/types/cloud-agent-client.js'
const base={schemaVersion:'1.0',agentId:'agt_12345678',conversationId:'cnv_12345678'};const commands=[
 {...base,commandId:'cmd_10000001',commandType:'conversation.message.admit',expectedRevision:1,payload:{text:'hello',idempotencyKey:'dst-1'}},
 {...base,commandId:'cmd_10000002',commandType:'wake.status.get',payload:{wakeId:'wak_12345678'}},
 {...base,commandId:'cmd_10000003',commandType:'wake.cancel',expectedRevision:1,payload:{wakeId:'wak_12345678'}},
 {...base,commandId:'cmd_10000004',commandType:'approval.respond',expectedRevision:1,payload:{approvalId:'apr_12345678',actionHash:'sha256:dst',decision:'denied'}},
 {...base,commandId:'cmd_10000005',commandType:'artifact.reference.get',payload:{artifactId:'art_12345678'}},
];const methods=['admitMessage','getWakeStatus','cancelWake','respondApproval','getArtifactReference'];const operation=(command)=>Promise.resolve({schemaVersion:'1.0',commandId:command.commandId,ok:true,result:{commandType:command.commandType}});const service=createAgentApplicationService({admitMessage:operation,getWakeStatus:operation,cancelWake:operation,respondApproval:operation,getArtifactReference:operation},async function*(){});const inProcess=createInProcessAgentClient(service);const dst=createDstCloudAgentClient(service);for(let i=0;i<commands.length;i+=1)assert.deepEqual(await dst[methods[i]](commands[i]),await inProcess[methods[i]](commands[i]));console.log(JSON.stringify({ok:true,surface:'dst-client-adapter',sharedApplicationService:true,operations:methods}))

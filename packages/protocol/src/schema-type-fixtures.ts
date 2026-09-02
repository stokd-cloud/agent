import type { ArtifactVersionDescriptor } from './artifacts.js'
import type { AuthorityContext, AuthorityRevision, LeaseGeneration } from './authority.js'
import type { AgentCommand } from './commands.js'
import type { AgentContextSnapshot } from './context.js'
import type { AgentErrorEnvelope } from './errors.js'
type Assert<Condition extends true> = Condition
type ErrorEnvelopeCannotSucceed = Assert<0 extends AgentErrorEnvelope['exitCode'] ? false : true>
const _errorEnvelopeCannotSucceed: ErrorEnvelopeCannotSucceed = true
void _errorEnvelopeCannotSucceed
import type { AgentEvent } from './events.js'
import type { HostCapabilityDescriptor } from './host.js'
import type { AgentId, ApprovalId, ArtifactId, ArtifactVersionId, AttemptId, CommandId, ContextSnapshotId, ConversationId, EventId, HostId, OwnerSubject, WakeId, WorkAttemptId, WorkId } from './ids.js'
import type { WorkLaunchReceipt } from './work.js'
const agentId='agt_12345678' as AgentId;const conversationId='cnv_12345678' as ConversationId;const wakeId='wak_12345678' as WakeId;const attemptId='atm_12345678' as AttemptId;const hostId='hst_12345678' as HostId;const artifactId='art_12345678' as ArtifactId
export const SCHEMA_TYPE_FIXTURES={
 artifact:{schemaVersion:'1.0',artifactId,versionId:'arv_12345678' as ArtifactVersionId,agentId,safeFilename:'result.txt',contentType:'text/plain',byteLength:4,sha256:'a'.repeat(64),objectKey:'Ada/art_12345678/arv_12345678/result.txt',createdAt:'2026-09-01T00:00:00Z'} satisfies ArtifactVersionDescriptor,
 authority:{schemaVersion:'1.0',ownerSubject:'own_12345678' as OwnerSubject,agentId,authorityRevision:1 as AuthorityRevision,hostId,expiresAt:'2026-09-01T00:01:00Z',permittedActions:['conversation.read'],permittedScopes:['agent:agt_12345678']} satisfies AuthorityContext,
 context:{schemaVersion:'1.0',snapshotId:'ctx_12345678' as ContextSnapshotId,agentId,conversationId,wakeId,attemptId,authorityRevision:1 as AuthorityRevision,policy:{mode:'coordinator'},identity:{name:'Ada'},responsibilities:[{repo:'stokd-cloud/agent'}],activeCommitments:[],memories:[],conversationSummary:'',recentTurns:[],currentPrompt:'hello',selections:[{sourceId:'identity:1',sourceRevision:1,reason:'pinned identity',tokenCount:4}],modelVersion:'model-1',toolVersion:'tool-1',policyVersion:'policy-1',tokenCounts:{total:10,currentPrompt:1}} satisfies AgentContextSnapshot,
 error:{schemaVersion:'1.0',errorId:'err_invalid_request',code:'invalid_request',message:'invalid request',exitCode:2,retryable:false} satisfies AgentErrorEnvelope,
 host:{schemaVersion:'1.0',hostId,platform:'darwin',architecture:'arm64',nodeVersion:'24.15.0',containerEngine:'none',modelProviders:[],repositoryBindings:[],capabilities:[],observedAt:'2026-09-01T00:00:00Z'} satisfies HostCapabilityDescriptor,
 work:{schemaVersion:'1.0',workId:'wrk_12345678' as WorkId,workAttemptId:'wka_12345678' as WorkAttemptId,agentId,hostId,generation:1 as LeaseGeneration,authorityRevision:1 as AuthorityRevision,state:'running',backend:'standalone',artifactIds:[artifactId],launchedAt:'2026-09-01T00:00:00Z',receiptHash:'sha256:receipt'} satisfies WorkLaunchReceipt,
 commands:[
  {schemaVersion:'1.0',commandId:'cmd_00000001' as CommandId,commandType:'conversation.message.admit',agentId,conversationId,expectedRevision:1 as AuthorityRevision,payload:{text:'hello',idempotencyKey:'ingress-1'}},
  {schemaVersion:'1.0',commandId:'cmd_00000002' as CommandId,commandType:'wake.status.get',agentId,conversationId,payload:{wakeId}},
  {schemaVersion:'1.0',commandId:'cmd_00000003' as CommandId,commandType:'wake.cancel',agentId,conversationId,expectedRevision:1 as AuthorityRevision,payload:{wakeId,reason:'owner request'}},
  {schemaVersion:'1.0',commandId:'cmd_00000004' as CommandId,commandType:'approval.respond',agentId,conversationId,expectedRevision:1 as AuthorityRevision,payload:{approvalId:'apr_12345678' as ApprovalId,actionHash:'sha256:abc',decision:'approved'}},
  {schemaVersion:'1.0',commandId:'cmd_00000005' as CommandId,commandType:'artifact.reference.get',agentId,conversationId,payload:{artifactId,versionId:'arv_12345678' as ArtifactVersionId}},
 ] satisfies AgentCommand[],
 event:{schemaVersion:'1.0',eventId:'evt_12345678' as EventId,sequence:1,agentId,conversationId,wakeId,attemptId,eventType:'wake.queued',stateChanging:true,occurredAt:'2026-09-01T00:00:00Z',payload:{reason:'message'}} satisfies AgentEvent,
}

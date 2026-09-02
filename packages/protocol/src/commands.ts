import type { AgentId, ApprovalId, ArtifactId, ArtifactVersionId, CommandId, ConversationId, WakeId } from './ids.js'
import type { AuthorityRevision } from './authority.js'

export type AgentCommandType =
  | 'conversation.message.admit'
  | 'wake.status.get'
  | 'wake.cancel'
  | 'approval.respond'
  | 'artifact.reference.get'

interface CommandBase<Type extends AgentCommandType, Payload> {
  readonly schemaVersion: string
  readonly commandId: CommandId
  readonly commandType: Type
  readonly agentId: AgentId
  readonly conversationId: ConversationId
  readonly payload: Payload
}
interface RevisionedCommand { readonly expectedRevision: AuthorityRevision }

export type AdmitMessageCommand = CommandBase<'conversation.message.admit', {
  readonly text: string
  readonly idempotencyKey: string
}> & RevisionedCommand
export type WakeStatusCommand = CommandBase<'wake.status.get', { readonly wakeId: WakeId }>
export type CancelWakeCommand = CommandBase<'wake.cancel', { readonly wakeId: WakeId; readonly reason?: string }> & RevisionedCommand
export type RespondApprovalCommand = CommandBase<'approval.respond', {
  readonly approvalId: ApprovalId
  readonly actionHash: string
  readonly decision: 'approved' | 'denied'
}> & RevisionedCommand
export type ArtifactReferenceCommand = CommandBase<'artifact.reference.get', {
  readonly artifactId: ArtifactId
  readonly versionId?: ArtifactVersionId
}>

export type AgentCommand = AdmitMessageCommand | WakeStatusCommand | CancelWakeCommand | RespondApprovalCommand | ArtifactReferenceCommand

export interface CommandSuccess<T = unknown> {
  readonly schemaVersion: '1.0'
  readonly commandId: CommandId
  readonly ok: true
  readonly result: T
}
export interface CommandFailure {
  readonly schemaVersion: '1.0'
  readonly commandId: CommandId
  readonly ok: false
  readonly error: import('./errors.js').AgentErrorEnvelope
}
export type CommandResponse<T = unknown> = CommandSuccess<T> | CommandFailure

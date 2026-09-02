
import type {
  AdmitMessageCommand,
  AgentCommand,
  ArtifactReferenceCommand,
  CancelWakeCommand,
  CommandResponse,
  RespondApprovalCommand,
  WakeStatusCommand,
} from './commands.js'
import type { AgentEvent } from './events.js'
import type { AgentId, ConversationId } from './ids.js'

export interface EventCursor {
  readonly agentId: AgentId
  readonly conversationId: ConversationId
  readonly afterSequence?: number
}

export interface AgentApplicationOperations {
  admitMessage(command: AdmitMessageCommand): Promise<CommandResponse>
  getWakeStatus(command: WakeStatusCommand): Promise<CommandResponse>
  cancelWake(command: CancelWakeCommand): Promise<CommandResponse>
  respondApproval(command: RespondApprovalCommand): Promise<CommandResponse>
  getArtifactReference(command: ArtifactReferenceCommand): Promise<CommandResponse>
}

export interface AgentApplicationService extends AgentApplicationOperations {
  execute(command: AgentCommand): Promise<CommandResponse>
  events(cursor: EventCursor): AsyncIterable<AgentEvent>
}

export interface AgentApplicationClient extends AgentApplicationOperations {
  execute(command: AgentCommand): Promise<CommandResponse>
  events(cursor: EventCursor): AsyncIterable<AgentEvent>
}

export function createAgentApplicationService(
  operations: AgentApplicationOperations,
  eventStream: (cursor: EventCursor) => AsyncIterable<AgentEvent>,
): AgentApplicationService {
  return {
    ...operations,
    execute(command) {
      switch (command.commandType) {
        case 'conversation.message.admit': return operations.admitMessage(command)
        case 'wake.status.get': return operations.getWakeStatus(command)
        case 'wake.cancel': return operations.cancelWake(command)
        case 'approval.respond': return operations.respondApproval(command)
        case 'artifact.reference.get': return operations.getArtifactReference(command)
      }
    },
    events: eventStream,
  }
}

export function createInProcessAgentClient(service: AgentApplicationService): AgentApplicationClient {
  return {
    execute: (command) => service.execute(command),
    admitMessage: (command) => service.admitMessage(command),
    getWakeStatus: (command) => service.getWakeStatus(command),
    cancelWake: (command) => service.cancelWake(command),
    respondApproval: (command) => service.respondApproval(command),
    getArtifactReference: (command) => service.getArtifactReference(command),
    events: (cursor) => service.events(cursor),
  }
}

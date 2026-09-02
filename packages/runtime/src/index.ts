
import {
  createAgentApplicationService,
  createInProcessAgentClient,
  unsupportedError,
  type AgentApplicationClient,
  type AgentApplicationOperations,
  type AgentApplicationService,
  type AgentCommand,
  type AgentEvent,
  type CommandResponse,
  type EventCursor,
} from '@stokd-cloud/agent-protocol'

function unsupported(command: AgentCommand): Promise<CommandResponse> {
  return Promise.resolve({
    schemaVersion: '1.0', commandId: command.commandId, ok: false,
    error: unsupportedError(`agent runtime operation ${command.commandType} is not implemented`),
  })
}

export function createUnsupportedApplicationService(): AgentApplicationService {
  const operations: AgentApplicationOperations = {
    admitMessage: unsupported,
    getWakeStatus: unsupported,
    cancelWake: unsupported,
    respondApproval: unsupported,
    getArtifactReference: unsupported,
  }
  return createAgentApplicationService(operations, async function* (_cursor: EventCursor): AsyncIterable<AgentEvent> {
    throw Object.assign(new Error('agent runtime event streaming is not implemented'), { exitCode: 7 })
  })
}

export function createHeadlessAgentClient(service: AgentApplicationService): AgentApplicationClient {
  return createInProcessAgentClient(service)
}
export async function startAgentRuntime(): Promise<7> { return 7 }


import {
  createInProcessAgentClient,
  type AgentApplicationClient,
  type AgentApplicationService,
} from '@stokd-cloud/agent-protocol'

export function createDstCloudAgentClient(service: AgentApplicationService): AgentApplicationClient {
  return createInProcessAgentClient(service)
}

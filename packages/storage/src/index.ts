
import { AgentProtocolError, unsupportedError } from '@stokd-cloud/agent-protocol'

export interface AgentStorage { close(): Promise<void> }
export async function openAgentStorage(): Promise<AgentStorage> {
  throw new AgentProtocolError(unsupportedError('agent storage is not implemented'))
}

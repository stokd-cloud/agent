
import { AgentProtocolError, unsupportedError, type AgentId, type AttemptId, type WakeId } from '@stokd-cloud/agent-protocol'

export interface FreshDshHandleRequest { readonly agentId: AgentId; readonly wakeId: WakeId; readonly attemptId: AttemptId }
export async function createFreshDshHandle(_request: FreshDshHandleRequest): Promise<never> {
  throw new AgentProtocolError(unsupportedError('fresh DSH coordinator handles are not implemented'))
}

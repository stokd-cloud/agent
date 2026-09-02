
import { AgentProtocolError, unsupportedError } from '@stokd-cloud/agent-protocol'

export async function connectStokdFactoryBridge(): Promise<never> {
  throw new AgentProtocolError(unsupportedError('the optional Stokd factory bridge is not implemented'))
}

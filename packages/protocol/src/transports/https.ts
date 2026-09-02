
import type { AgentCommand, CommandResponse } from '../commands.js'
import { decodeAgentCommand, encodeJson } from '../serialization.js'

export const AGENT_JSON_CONTENT_TYPE = 'application/vnd.stokd-agent.v1+json' as const

export function serializeHttpsCommand(command: AgentCommand): { readonly contentType: typeof AGENT_JSON_CONTENT_TYPE; readonly body: string } {
  return { contentType: AGENT_JSON_CONTENT_TYPE, body: encodeJson(command) }
}
export function deserializeHttpsCommand(body: string, contentType: string | undefined): AgentCommand {
  if (contentType?.split(';', 1)[0]?.trim() !== AGENT_JSON_CONTENT_TYPE) throw new TypeError(`unsupported content type: ${contentType ?? '<missing>'}`)
  return decodeAgentCommand(JSON.parse(body) as unknown)
}
export function serializeHttpsResponse(response: CommandResponse): { readonly contentType: typeof AGENT_JSON_CONTENT_TYPE; readonly body: string } {
  return { contentType: AGENT_JSON_CONTENT_TYPE, body: encodeJson(response) }
}

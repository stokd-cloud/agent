
import { decodeAgentCommand, encodeJson } from '../serialization.js'
import type { AgentCommand, CommandResponse } from '../commands.js'

export function encodeIpcCommand(command: AgentCommand): Uint8Array {
  return new TextEncoder().encode(`${encodeJson(command)}\n`)
}
export function decodeIpcCommand(frame: Uint8Array): AgentCommand {
  const text = new TextDecoder().decode(frame)
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) throw new TypeError('IPC frame must contain exactly one newline-terminated JSON value')
  return decodeAgentCommand(JSON.parse(text.slice(0, -1)) as unknown)
}
export function encodeIpcResponse(response: CommandResponse): Uint8Array {
  return new TextEncoder().encode(`${encodeJson(response)}\n`)
}

import type { AgentCommand, AgentCommandType, CommandResponse } from './commands.js'
import { decodeAgentEvent, type DecodedAgentEvent } from './events.js'
import { AgentProtocolError, invalidRequestError, unsupportedError } from './errors.js'
import { parseAgentId, type AgentIdKind } from './ids.js'
import { assertSupportedMajor } from './version.js'

const COMMAND_TYPES = new Set<AgentCommandType>([
  'conversation.message.admit', 'wake.status.get', 'wake.cancel', 'approval.respond', 'artifact.reference.get',
])
const COMMAND_FIELDS = new Set(['schemaVersion','commandId','commandType','agentId','conversationId','expectedRevision','payload'])
function invalid(message: string): never { throw new AgentProtocolError(invalidRequestError(message)) }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`)
  return value as Record<string, unknown>
}
function noExtra(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras=Object.keys(value).filter(key=>!allowed.includes(key))
  if(extras.length>0) invalid(`${label} contains unsupported fields: ${extras.join(', ')}`)
}
function nonempty(value: Record<string, unknown>, key: string, label='command.payload'): void {
  if (typeof value[key] !== 'string' || (value[key] as string).length === 0) invalid(`${label}.${key} must be a non-empty string`)
}
function branded(kind: AgentIdKind,value: unknown,label: string): void {
  try { parseAgentId(kind,value) } catch { invalid(`${label} is invalid`) }
}
function revision(command:Record<string,unknown>,required:boolean):void {
  if(required && command.expectedRevision===undefined) invalid('command.expectedRevision is required')
  if(!required && command.expectedRevision!==undefined) invalid('command.expectedRevision is not allowed for this query')
  if(command.expectedRevision!==undefined&&(!Number.isSafeInteger(command.expectedRevision)||(command.expectedRevision as number)<0))invalid('command.expectedRevision must be a non-negative safe integer')
}

export function encodeJson(value: unknown): string { return JSON.stringify(value) }
export function decodeJson(text: string): unknown { return JSON.parse(text) as unknown }

export function decodeAgentCommand(value: unknown): AgentCommand {
  const command = record(value, 'command')
  assertSupportedMajor(command.schemaVersion)
  noExtra(command,[...COMMAND_FIELDS],'command')
  nonempty(command,'commandId','command');nonempty(command,'commandType','command');nonempty(command,'agentId','command');nonempty(command,'conversationId','command')
  branded('command',command.commandId,'command.commandId');branded('agent',command.agentId,'command.agentId');branded('conversation',command.conversationId,'command.conversationId')
  if (!COMMAND_TYPES.has(command.commandType as AgentCommandType)) throw new AgentProtocolError(unsupportedError(`unknown command type: ${String(command.commandType)}`))
  const payload = record(command.payload, 'command.payload')
  switch (command.commandType as AgentCommandType) {
    case 'conversation.message.admit':
      revision(command,true);noExtra(payload,['text','idempotencyKey'],'command.payload');nonempty(payload,'text');nonempty(payload,'idempotencyKey');break
    case 'wake.status.get':
      revision(command,false);noExtra(payload,['wakeId'],'command.payload');nonempty(payload,'wakeId');branded('wake',payload.wakeId,'command.payload.wakeId');break
    case 'wake.cancel':
      revision(command,true);noExtra(payload,['wakeId','reason'],'command.payload');nonempty(payload,'wakeId');branded('wake',payload.wakeId,'command.payload.wakeId');if(payload.reason!==undefined)nonempty(payload,'reason');break
    case 'approval.respond':
      revision(command,true);noExtra(payload,['approvalId','actionHash','decision'],'command.payload');nonempty(payload,'approvalId');branded('approval',payload.approvalId,'command.payload.approvalId');nonempty(payload,'actionHash')
      if(payload.decision!=='approved'&&payload.decision!=='denied')invalid('command.payload.decision must be approved or denied');break
    case 'artifact.reference.get':
      revision(command,false);noExtra(payload,['artifactId','versionId'],'command.payload');nonempty(payload,'artifactId');branded('artifact',payload.artifactId,'command.payload.artifactId');if(payload.versionId!==undefined){nonempty(payload,'versionId');branded('artifactVersion',payload.versionId,'command.payload.versionId')}break
  }
  return command as unknown as AgentCommand
}
export function encodeCommandResponse(response: CommandResponse): string { return encodeJson(response) }
export function decodeEventJson(text: string): DecodedAgentEvent { return decodeAgentEvent(decodeJson(text)) }

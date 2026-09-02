import { AgentProtocolError, invalidRequestError, unsupportedError } from './errors.js'
import { parseAgentId, type AgentId, type AttemptId, type ConversationId, type EventId, type WakeId } from './ids.js'
import { assertSupportedMajor } from './version.js'

export const KNOWN_EVENT_TYPES = [
  'message.admitted', 'wake.queued', 'wake.running', 'wake.awaiting_input',
  'wake.completed', 'wake.failed', 'wake.cancelled', 'approval.requested',
  'work.updated', 'artifact.updated',
] as const
export type KnownAgentEventType = typeof KNOWN_EVENT_TYPES[number]
export interface AgentEvent {
  readonly schemaVersion: string
  readonly eventId: EventId
  readonly sequence: number
  readonly agentId: AgentId
  readonly conversationId: ConversationId
  readonly wakeId: WakeId
  readonly attemptId: AttemptId
  readonly eventType: KnownAgentEventType
  readonly stateChanging: true
  readonly occurredAt: string
  readonly payload: Readonly<Record<string, unknown>>
}
export interface SkippedInformationalEvent {
  readonly kind: 'skipped_informational_event'
  readonly schemaVersion: string
  readonly eventId: string
  readonly eventType: string
  readonly sequence: number
  readonly stateChanged: false
}
export type DecodedAgentEvent = AgentEvent | SkippedInformationalEvent
const FIELDS=['schemaVersion','eventId','sequence','agentId','conversationId','wakeId','attemptId','eventType','stateChanging','occurredAt','payload'] as const
function invalid(message:string):never{throw new AgentProtocolError(invalidRequestError(message))}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('event must be an object')
  return value as Record<string, unknown>
}
function branded(kind:Parameters<typeof parseAgentId>[0],value:unknown,label:string):void{try{parseAgentId(kind,value)}catch{invalid(`${label} is invalid`)}}
export function decodeAgentEvent(value: unknown): DecodedAgentEvent {
  const candidate=object(value);assertSupportedMajor(candidate.schemaVersion)
  const extras=Object.keys(candidate).filter(key=>!FIELDS.includes(key as typeof FIELDS[number]));if(extras.length>0)invalid(`event contains unsupported fields: ${extras.join(', ')}`)
  for(const key of ['eventId','agentId','conversationId','wakeId','attemptId','eventType','occurredAt'] as const)if(typeof candidate[key]!=='string'||candidate[key].length===0)invalid(`event.${key} must be a non-empty string`)
  branded('event',candidate.eventId,'event.eventId');branded('agent',candidate.agentId,'event.agentId');branded('conversation',candidate.conversationId,'event.conversationId');branded('wake',candidate.wakeId,'event.wakeId');branded('attempt',candidate.attemptId,'event.attemptId')
  if(!Number.isSafeInteger(candidate.sequence)||(candidate.sequence as number)<0)invalid('event.sequence must be a non-negative safe integer')
  if(Number.isNaN(Date.parse(candidate.occurredAt as string)))invalid('event.occurredAt must be an RFC 3339 date-time')
  if(!candidate.payload||typeof candidate.payload!=='object'||Array.isArray(candidate.payload))invalid('event.payload must be an object')
  const eventType=candidate.eventType as string
  if(!KNOWN_EVENT_TYPES.includes(eventType as KnownAgentEventType)){
    if(candidate.stateChanging!==false)throw new AgentProtocolError(unsupportedError(`unknown state-changing event type: ${eventType}`,'unknown_state_changing_event',{eventType}))
    return{kind:'skipped_informational_event',schemaVersion:candidate.schemaVersion as string,eventId:candidate.eventId as string,eventType,sequence:candidate.sequence as number,stateChanged:false}
  }
  if(candidate.stateChanging!==true)invalid('known domain events must be state-changing')
  return candidate as unknown as AgentEvent
}

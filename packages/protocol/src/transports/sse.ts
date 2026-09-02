
import { decodeAgentEvent, type AgentEvent, type DecodedAgentEvent } from '../events.js'

export const AGENT_EVENT_STREAM_CONTENT_TYPE = 'text/event-stream; charset=utf-8' as const

export function serializeSseEvent(event: AgentEvent): string {
  return `id: ${event.eventId}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`
}

export function deserializeSseEvent(frame: string): DecodedAgentEvent {
  const data = frame.split(/\r?\n/).find((line) => line.startsWith('data: '))
  if (!data) throw new TypeError('SSE frame is missing data')
  return decodeAgentEvent(JSON.parse(data.slice(6)) as unknown)
}

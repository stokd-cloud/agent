export interface Agent { id: string; name: string; identity: string; remit: string }
export interface Conversation { id: string; agentId: string; title: string; cursor: number; updatedAt: number }
export interface Message { seq: number; role: string; content: string; turnId: string }
export interface Memory { id: string; content: string; revision: number; sourceSeq: number }
export interface Action { kind: string; title: string; content?: string }
export interface Approval { id: string; action: Action; state: string }
export interface Work { id: string; title: string; status: string }
export interface Artifact { id: string; title: string; content?: string }
export interface Turn { id: string; state: string; stage: string; model: string; promptBytes: number; error: string }
export interface Snapshot {
  agent: Agent
  conversation: Conversation
  messages: Message[]
  turn: Turn | null
  artifacts: Artifact[]
  work: Work[]
  approvals: Approval[]
  summary: { content: string; throughSeq: number }
}
export interface DomainEvent {
  conversationId: string
  seq: number
  kind: string
  data: Record<string, unknown>
  createdAt: number
}
export interface RoutedResult<T = unknown> { method?: string; value?: T; view?: string; params?: Record<string, unknown> }
export interface Transport {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<RoutedResult<T>>
}

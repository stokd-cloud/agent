
import type { AuthorityRevision } from './authority.js'
import type { AgentId, AttemptId, ContextSnapshotId, ConversationId, WakeId } from './ids.js'

export interface ContextSelection {
  readonly sourceId: string
  readonly sourceRevision: number
  readonly reason: string
  readonly tokenCount: number
}

export interface AgentContextSnapshot {
  readonly schemaVersion: '1.0'
  readonly snapshotId: ContextSnapshotId
  readonly agentId: AgentId
  readonly conversationId: ConversationId
  readonly wakeId: WakeId
  readonly attemptId: AttemptId
  readonly authorityRevision: AuthorityRevision
  readonly policy: Readonly<Record<string, unknown>>
  readonly identity: Readonly<Record<string, unknown>>
  readonly responsibilities: readonly Readonly<Record<string, unknown>>[]
  readonly activeCommitments: readonly Readonly<Record<string, unknown>>[]
  readonly memories: readonly Readonly<Record<string, unknown>>[]
  readonly conversationSummary: string
  readonly recentTurns: readonly Readonly<Record<string, unknown>>[]
  readonly currentPrompt: string
  readonly selections: readonly ContextSelection[]
  readonly modelVersion: string
  readonly toolVersion: string
  readonly policyVersion: string
  readonly tokenCounts: Readonly<{ total: number; currentPrompt: number }>
}

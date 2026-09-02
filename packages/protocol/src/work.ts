
import type { AuthorityRevision, LeaseGeneration } from './authority.js'
import type { AgentId, ArtifactId, HostId, WorkAttemptId, WorkId } from './ids.js'

export type WorkState = 'requested' | 'launching' | 'submitted' | 'running' | 'awaiting_input' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'unknown'

export interface WorkLaunchReceipt {
  readonly schemaVersion: '1.0'
  readonly workId: WorkId
  readonly workAttemptId: WorkAttemptId
  readonly agentId: AgentId
  readonly hostId: HostId
  readonly generation: LeaseGeneration
  readonly authorityRevision: AuthorityRevision
  readonly state: WorkState
  readonly backend: 'standalone' | 'stokd'
  readonly externalId?: string
  readonly containerLabel?: string
  readonly artifactIds: readonly ArtifactId[]
  readonly launchedAt: string
  readonly receiptHash: string
}

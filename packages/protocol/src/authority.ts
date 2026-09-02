
import type { AgentId, AttemptId, HostId, OwnerSubject, WorkAttemptId, WorkId } from './ids.js'

export type AuthorityRevision = number & { readonly __brand: 'AuthorityRevision' }
export type LeaseGeneration = number & { readonly __brand: 'LeaseGeneration' }

export interface AuthorityContext {
  readonly schemaVersion: '1.0'
  readonly ownerSubject: OwnerSubject
  readonly agentId: AgentId
  readonly authorityRevision: AuthorityRevision
  readonly coordinatorAttemptId?: AttemptId
  readonly coordinatorGeneration?: LeaseGeneration
  readonly workId?: WorkId
  readonly workAttemptId?: WorkAttemptId
  readonly workGeneration?: LeaseGeneration
  readonly hostId: HostId
  readonly expiresAt: string
  readonly permittedActions: readonly string[]
  readonly permittedScopes: readonly string[]
}

export function authorityRevision(value: number): AuthorityRevision {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('authority revision must be a non-negative safe integer')
  return value as AuthorityRevision
}

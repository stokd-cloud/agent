
export type Brand<T, Name extends string> = T & { readonly __brand: Name }

export type OwnerSubject = Brand<string, 'OwnerSubject'>
export type AgentId = Brand<string, 'AgentId'>
export type ConversationId = Brand<string, 'ConversationId'>
export type WakeId = Brand<string, 'WakeId'>
export type AttemptId = Brand<string, 'AttemptId'>
export type CommandId = Brand<string, 'CommandId'>
export type EventId = Brand<string, 'EventId'>
export type ContextSnapshotId = Brand<string, 'ContextSnapshotId'>
export type HostId = Brand<string, 'HostId'>
export type WorkId = Brand<string, 'WorkId'>
export type WorkAttemptId = Brand<string, 'WorkAttemptId'>
export type ApprovalId = Brand<string, 'ApprovalId'>
export type ArtifactId = Brand<string, 'ArtifactId'>
export type ArtifactVersionId = Brand<string, 'ArtifactVersionId'>
export type UploadId = Brand<string, 'UploadId'>
export type ImportId = Brand<string, 'ImportId'>

const PREFIXES = {
  owner: 'own', agent: 'agt', conversation: 'cnv', wake: 'wak', attempt: 'atm',
  command: 'cmd', event: 'evt', context: 'ctx', host: 'hst', work: 'wrk',
  workAttempt: 'wka', approval: 'apr', artifact: 'art', artifactVersion: 'arv',
  upload: 'upl', import: 'imp',
} as const

export type AgentIdKind = keyof typeof PREFIXES

export function parseAgentId<Kind extends AgentIdKind>(kind: Kind, value: unknown): Brand<string, Kind> {
  if (typeof value !== 'string') throw new TypeError(`${kind} id must be a string`)
  const prefix = PREFIXES[kind]
  if (!new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$`).test(value)) {
    throw new TypeError(`invalid ${kind} id`)
  }
  return value as Brand<string, Kind>
}

export function isAgentId(kind: AgentIdKind, value: unknown): value is string {
  try { parseAgentId(kind, value); return true } catch { return false }
}

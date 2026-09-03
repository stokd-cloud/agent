export const AGENT_SCHEMA_VERSION = 1 as const
export const MINIMUM_COMPATIBLE_SCHEMA_VERSION = 0 as const

export type IndexDirection = 1 | -1 | 'hashed'

export interface AgentIndexDefinition {
  readonly name: string
  readonly key: Readonly<Record<string, IndexDirection>>
  readonly unique?: boolean
  readonly sparse?: boolean
  readonly partialFilterExpression?: Readonly<Record<string, unknown>>
  readonly expireAfterSeconds?: number
}

export interface AgentCollectionDefinition {
  readonly name: string
  readonly purpose: string
  readonly indexes: readonly AgentIndexDefinition[]
}

const collection = (name: string, purpose: string, indexes: readonly AgentIndexDefinition[]): AgentCollectionDefinition => ({ name, purpose, indexes })

export const AGENT_COLLECTIONS: readonly AgentCollectionDefinition[] = [
  collection('schema_state', 'schema compatibility and migration state', [
    { name: 'schema_version', key: { schemaVersion: 1 } },
  ]),
  collection('migration_runs', 'interrupt-resumable migration journal', [
    { name: 'migration_version_unique', key: { targetVersion: 1 }, unique: true },
    { name: 'migration_status', key: { status: 1, updatedAt: 1 } },
  ]),
  collection('accounts', 'stable owner identity', [
    { name: 'owner_subject_unique', key: { ownerSubject: 1 }, unique: true },
  ]),
  collection('sessions', 'revocable owner sessions', [
    { name: 'session_id_unique', key: { sessionId: 1 }, unique: true },
    { name: 'session_owner_expiry', key: { ownerSubject: 1, expiresAt: 1 } },
  ]),
  collection('hosts', 'enrolled host capabilities', [
    { name: 'host_id_unique', key: { hostId: 1 }, unique: true },
    { name: 'host_owner_status', key: { ownerSubject: 1, status: 1, lastSeenAt: -1 } },
  ]),
  collection('agents', 'durable named coordinator records', [
    { name: 'agent_id_unique', key: { agentId: 1 }, unique: true },
    { name: 'owner_normalized_name_unique', key: { ownerSubject: 1, normalizedName: 1 }, unique: true },
    { name: 'owner_agent_state', key: { ownerSubject: 1, state: 1, createdAt: 1 } },
  ]),
  collection('agent_profile_revisions', 'immutable identity and remit revisions', [
    { name: 'agent_profile_revision_unique', key: { agentId: 1, revision: 1 }, unique: true },
    { name: 'agent_profile_owner', key: { ownerSubject: 1, agentId: 1, createdAt: -1 } },
  ]),
  collection('conversations', 'owner-scoped conversation heads', [
    { name: 'conversation_id_unique', key: { conversationId: 1 }, unique: true },
    { name: 'agent_conversation_updated', key: { agentId: 1, updatedAt: -1 } },
  ]),
  collection('conversation_events', 'monotonic durable event journal', [
    { name: 'event_id_unique', key: { eventId: 1 }, unique: true },
    { name: 'conversation_sequence_unique', key: { conversationId: 1, sequence: 1 }, unique: true },
    { name: 'agent_event_time', key: { agentId: 1, occurredAt: 1 } },
  ]),
  collection('wakes', 'coordinator wake lifecycle', [
    { name: 'wake_id_unique', key: { wakeId: 1 }, unique: true },
    { name: 'agent_fifo', key: { agentId: 1, ingressSequence: 1 }, unique: true },
    { name: 'wake_state_queue', key: { state: 1, queuedAt: 1 } },
  ]),
  collection('wake_attempts', 'fenced wake attempts', [
    { name: 'attempt_id_unique', key: { attemptId: 1 }, unique: true },
    { name: 'wake_generation_unique', key: { wakeId: 1, generation: 1 }, unique: true },
  ]),
  collection('context_snapshots', 'immutable context selection records', [
    { name: 'snapshot_id_unique', key: { snapshotId: 1 }, unique: true },
    { name: 'wake_attempt_snapshot', key: { wakeId: 1, attemptId: 1 }, unique: true },
  ]),
  collection('memories', 'typed current memory heads and tombstones', [
    { name: 'memory_id_unique', key: { memoryId: 1 }, unique: true },
    { name: 'agent_memory_scope', key: { agentId: 1, scope: 1, state: 1 } },
  ]),
  collection('memory_revisions', 'immutable memory revision history', [
    { name: 'memory_revision_unique', key: { memoryId: 1, revision: 1 }, unique: true },
  ]),
  collection('commitments', 'active and completed commitments', [
    { name: 'commitment_id_unique', key: { commitmentId: 1 }, unique: true },
    { name: 'agent_commitment_state', key: { agentId: 1, state: 1, updatedAt: -1 } },
  ]),
  collection('work_requests', 'external work intents and observed receipts', [
    { name: 'work_id_unique', key: { workId: 1 }, unique: true },
    { name: 'work_attempt_generation_unique', key: { workId: 1, workAttemptGeneration: 1 }, unique: true },
    { name: 'agent_work_state', key: { agentId: 1, state: 1, updatedAt: -1 } },
  ]),
  collection('approvals', 'attempt-bound approval records', [
    { name: 'approval_id_unique', key: { approvalId: 1 }, unique: true },
    { name: 'attempt_action_hash_unique', key: { attemptId: 1, actionHash: 1 }, unique: true },
    { name: 'approval_deadline', key: { state: 1, expiresAt: 1 } },
  ]),
  collection('artifact_versions', 'immutable S3 version custody metadata', [
    { name: 'artifact_version_id_unique', key: { versionId: 1 }, unique: true },
    { name: 'artifact_ordinal_unique', key: { artifactId: 1, ordinal: 1 }, unique: true },
    { name: 'object_version_unique', key: { objectKey: 1, s3VersionId: 1 }, unique: true },
    { name: 'agent_artifact_state', key: { agentId: 1, state: 1, createdAt: -1 } },
  ]),
  collection('imports', 'resumable import batches and provenance', [
    { name: 'import_id_unique', key: { importId: 1 }, unique: true },
    { name: 'owner_source_hash_unique', key: { ownerSubject: 1, sourceManifestSha256: 1 }, unique: true },
  ]),
  collection('audit_events', 'append-only owner-safe audit trail', [
    { name: 'audit_id_unique', key: { auditId: 1 }, unique: true },
    { name: 'owner_audit_time', key: { ownerSubject: 1, occurredAt: -1 } },
  ]),
  collection('idempotency_receipts', 'request hash and durable result receipts', [
    { name: 'idempotency_scope_key_unique', key: { ownerSubject: 1, scope: 1, idempotencyKey: 1 }, unique: true },
    { name: 'command_id_unique', key: { commandId: 1 }, unique: true },
    { name: 'idempotency_state', key: { state: 1, updatedAt: 1 } },
  ]),
  collection('coordinator_leases', 'server-time coordinator fencing generations', [
    { name: 'agent_lease_unique', key: { agentId: 1 }, unique: true },
    { name: 'lease_expiry', key: { leaseExpiresAt: 1 } },
    { name: 'lease_generation', key: { agentId: 1, generation: 1 }, unique: true },
  ]),
  collection('dispatch_intents', 'durable side-effect intents and receipts', [
    { name: 'dispatch_intent_id_unique', key: { intentId: 1 }, unique: true },
    { name: 'work_attempt_intent_unique', key: { workId: 1, workAttemptGeneration: 1, intentHash: 1 }, unique: true },
  ]),
  collection('backup_manifests', 'backup archive and object custody manifests', [
    { name: 'backup_id_unique', key: { backupId: 1 }, unique: true },
    { name: 'source_restore_point', key: { sourceEnvironment: 1, 'restorePoint.completedAt': -1 } },
  ]),
  collection('restore_reconciliations', 'isolated restore reports and explicit reconciliation state', [
    { name: 'restore_id_unique', key: { restoreId: 1 }, unique: true },
    { name: 'backup_restore_unique', key: { backupId: 1, targetEnvironment: 1 }, unique: true },
  ]),
] as const

export const AGENT_COLLECTION_NAMES = AGENT_COLLECTIONS.map(value => value.name)

export function storageCatalog(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: '1.0',
    currentSchemaVersion: AGENT_SCHEMA_VERSION,
    minimumCompatibleSchemaVersion: MINIMUM_COMPATIBLE_SCHEMA_VERSION,
    collections: AGENT_COLLECTIONS,
  }
}

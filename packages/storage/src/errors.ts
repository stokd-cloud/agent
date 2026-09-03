export type AgentStorageErrorCode =
  | 'invalid_storage_config'
  | 'storage_not_ready'
  | 'unsupported_mongodb_version'
  | 'unsupported_schema_version'
  | 'migration_conflict'
  | 'migration_interrupted'
  | 'revision_conflict'
  | 'stale_fence'
  | 'idempotency_conflict'
  | 'backup_failed'
  | 'restore_failed'
  | 'object_custody_mismatch'

export class AgentStorageError extends Error {
  readonly code: AgentStorageErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: AgentStorageErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = 'AgentStorageError'
    this.code = code
    this.details = details
  }
}

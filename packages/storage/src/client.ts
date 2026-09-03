import { MongoClient, type Db } from 'mongodb'
import { AgentProtocolError, unsupportedError } from '@stokd-cloud/agent-protocol'
import { normalizeStorageConfig, type AgentStorageConfig, type NormalizedAgentStorageConfig } from './config.js'
import { migrateAgentStorage, assertSchemaCompatibility, verifyStorageCatalog, type MigrationOptions, type MigrationResult } from './migration.js'
import { assertTransactionSupport, inspectMongoMigrationReadiness, inspectMongoServiceReadiness, type MongoReadiness } from './readiness.js'
import { AgentStorageError } from './errors.js'

export interface OpenAgentStorageOptions {
  readonly migrate?: boolean
  readonly migration?: MigrationOptions
  readonly transactionProbe?: boolean
}

export interface AgentStorage {
  readonly client: MongoClient
  readonly db: Db
  readonly config: NormalizedAgentStorageConfig
  readonly readiness: MongoReadiness
  readonly migration: MigrationResult | null
  close(): Promise<void>
}

export async function openAgentStorage(config?: AgentStorageConfig, options: OpenAgentStorageOptions = {}): Promise<AgentStorage> {
  if (!config) throw new AgentProtocolError(unsupportedError('agent storage configuration is required'))
  const normalized = normalizeStorageConfig(config)
  if (options.migrate === true && normalized.principal !== 'migration') throw new AgentStorageError('invalid_storage_config', 'migrations require the distinct migration principal')
  if (options.migrate !== true && normalized.principal !== 'runtime') throw new AgentStorageError('invalid_storage_config', 'service startup requires the database-scoped runtime principal')
  const client = new MongoClient(normalized.uri, {
    appName: normalized.applicationName,
    connectTimeoutMS: normalized.connectTimeoutMS,
    serverSelectionTimeoutMS: normalized.connectTimeoutMS,
    directConnection: false,
    retryReads: true,
    retryWrites: true,
    readConcern: { level: 'majority' },
    writeConcern: { w: 'majority', j: true },
  })
  try {
    await client.connect()
    const db = client.db(normalized.databaseName)
    const readiness = options.migrate === true
      ? await inspectMongoMigrationReadiness(db, normalized)
      : await inspectMongoServiceReadiness(db, normalized)
    let migration: MigrationResult | null = null
    if (options.migrate === true) migration = await migrateAgentStorage(db, options.migration)
    else await assertSchemaCompatibility(db, normalized.expectedFeatureCompatibilityVersion)
    await verifyStorageCatalog(db)
    if (options.transactionProbe !== false) await assertTransactionSupport(db)
    return { client, db, config: normalized, readiness, migration, close: () => client.close() }
  } catch (error) {
    await client.close().catch(() => undefined)
    throw error
  }
}

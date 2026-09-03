import { createHash, randomUUID } from 'node:crypto'
import type { Db, Document, IndexDescription } from 'mongodb'
import { Long } from 'mongodb'
import { AGENT_COLLECTIONS, AGENT_SCHEMA_VERSION, MINIMUM_COMPATIBLE_SCHEMA_VERSION, type AgentIndexDefinition } from './catalog.js'
import { AgentStorageError } from './errors.js'
import { MONGODB_FCV } from './config.js'
import { readServerTime } from './readiness.js'
import { withAgentTransaction } from './transactions.js'

const SCHEMA_STATE_ID = 'agent-schema'

interface SchemaState extends Document {
  readonly _id: typeof SCHEMA_STATE_ID
  readonly schemaVersion: number
  readonly minimumCompatibleVersion: number
  readonly migrationStatus: 'ready' | 'running' | 'interrupted'
  readonly migrationToken?: string
  readonly migrationChecksum: string
  readonly migrationLeaseExpiresAt?: Date
  readonly featureCompatibilityVersion: string
  readonly updatedAt: Date
}

export interface MigrationOptions {
  readonly interruptAfterStep?: number
  readonly migrationToken?: string
  readonly leaseDurationMS?: number
  readonly onStep?: (step: string, stepNumber: number) => Promise<void> | void
}

export interface MigrationResult {
  readonly fromVersion: number
  readonly toVersion: number
  readonly applied: boolean
  readonly resumed: boolean
  readonly completedSteps: readonly string[]
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const AGENT_MIGRATION_CHECKSUM = createHash('sha256').update(stable({
  targetVersion: AGENT_SCHEMA_VERSION,
  minimumCompatibleVersion: MINIMUM_COMPATIBLE_SCHEMA_VERSION,
  collections: AGENT_COLLECTIONS,
})).digest('hex')

function indexDescription(index: AgentIndexDefinition): IndexDescription {
  return {
    key: index.key,
    name: index.name,
    ...(index.unique === undefined ? {} : { unique: index.unique }),
    ...(index.sparse === undefined ? {} : { sparse: index.sparse }),
    ...(index.partialFilterExpression === undefined ? {} : { partialFilterExpression: index.partialFilterExpression }),
    ...(index.expireAfterSeconds === undefined ? {} : { expireAfterSeconds: index.expireAfterSeconds }),
  }
}

async function ensureCollection(db: Db, name: string): Promise<void> {
  const existing = await db.listCollections({ name }, { nameOnly: true }).hasNext()
  if (!existing) await db.createCollection(name)
}

async function ensureIndex(db: Db, collectionName: string, definition: AgentIndexDefinition): Promise<void> {
  const collection = db.collection(collectionName)
  const existing = (await collection.listIndexes().toArray()).find(index => index.name === definition.name)
  if (existing) {
    const expected = indexDescription(definition)
    const actual = {
      key: existing.key,
      name: existing.name,
      ...(existing.unique === undefined ? {} : { unique: existing.unique }),
      ...(existing.sparse === undefined ? {} : { sparse: existing.sparse }),
      ...(existing.partialFilterExpression === undefined ? {} : { partialFilterExpression: existing.partialFilterExpression }),
      ...(existing.expireAfterSeconds === undefined ? {} : { expireAfterSeconds: existing.expireAfterSeconds }),
    }
    if (stable(actual) !== stable(expected)) {
      throw new AgentStorageError('migration_conflict', `index ${collectionName}.${definition.name} conflicts with the frozen catalog`, { expected, actual })
    }
    return
  }
  await collection.createIndex(definition.key, indexDescription(definition))
}

async function initializeState(db: Db): Promise<SchemaState> {
  await ensureCollection(db, 'schema_state')
  await ensureCollection(db, 'migration_runs')
  const now = await readServerTime(db)
  await db.collection<SchemaState>('schema_state').updateOne(
    { _id: SCHEMA_STATE_ID },
    { $setOnInsert: { schemaVersion: 0, minimumCompatibleVersion: 0, migrationStatus: 'ready', migrationChecksum: AGENT_MIGRATION_CHECKSUM, featureCompatibilityVersion: '7.0', updatedAt: now } },
    { upsert: true },
  )
  const state = await db.collection<SchemaState>('schema_state').findOne({ _id: SCHEMA_STATE_ID })
  if (!state) throw new AgentStorageError('storage_not_ready', 'schema state could not be initialized')
  return state
}

export async function assertSchemaCompatibility(db: Db, expectedFeatureCompatibilityVersion: string = MONGODB_FCV): Promise<SchemaState> {
  const state = await db.collection<SchemaState>('schema_state').findOne({ _id: SCHEMA_STATE_ID })
  if (!state) throw new AgentStorageError('storage_not_ready', 'schema state is absent; an authorized migration must run before service startup')
  if (state.migrationChecksum !== AGENT_MIGRATION_CHECKSUM) {
    throw new AgentStorageError('migration_conflict', 'database migration checksum differs from this release', { databaseChecksum: state.migrationChecksum, expectedChecksum: AGENT_MIGRATION_CHECKSUM })
  }
  if (state.migrationStatus !== 'ready') throw new AgentStorageError('migration_conflict', `schema is not ready: ${state.migrationStatus}`)
  if (state.featureCompatibilityVersion !== expectedFeatureCompatibilityVersion) {
    throw new AgentStorageError('unsupported_mongodb_version', `schema was migrated under FCV ${state.featureCompatibilityVersion}; expected ${expectedFeatureCompatibilityVersion}`)
  }
  if (state.schemaVersion > AGENT_SCHEMA_VERSION || state.minimumCompatibleVersion > AGENT_SCHEMA_VERSION) {
    throw new AgentStorageError('unsupported_schema_version', `database schema ${state.schemaVersion} requires a newer client`, {
      databaseSchemaVersion: state.schemaVersion,
      clientSchemaVersion: AGENT_SCHEMA_VERSION,
    })
  }
  if (state.schemaVersion < MINIMUM_COMPATIBLE_SCHEMA_VERSION) {
    throw new AgentStorageError('unsupported_schema_version', `database schema ${state.schemaVersion} is older than supported ${MINIMUM_COMPATIBLE_SCHEMA_VERSION}`)
  }
  return state
}

export async function verifyStorageCatalog(db: Db): Promise<void> {
  const collections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(value => value.name))
  for (const definition of AGENT_COLLECTIONS) {
    if (!collections.has(definition.name)) throw new AgentStorageError('storage_not_ready', `missing collection ${definition.name}`)
    const actual = await db.collection(definition.name).listIndexes().toArray()
    const byName = new Map(actual.map(index => [index.name, index]))
    for (const expected of definition.indexes) {
      const index = byName.get(expected.name)
      if (!index) throw new AgentStorageError('storage_not_ready', `missing index ${definition.name}.${expected.name}`)
      const comparable = {
        key: index.key,
        name: index.name,
        ...(index.unique === undefined ? {} : { unique: index.unique }),
        ...(index.sparse === undefined ? {} : { sparse: index.sparse }),
        ...(index.partialFilterExpression === undefined ? {} : { partialFilterExpression: index.partialFilterExpression }),
        ...(index.expireAfterSeconds === undefined ? {} : { expireAfterSeconds: index.expireAfterSeconds }),
      }
      if (stable(comparable) !== stable(indexDescription(expected))) {
        throw new AgentStorageError('storage_not_ready', `index drift ${definition.name}.${expected.name}`)
      }
    }
  }
}

export async function migrateAgentStorage(db: Db, options: MigrationOptions = {}): Promise<MigrationResult> {
  const existing = await db.collection<SchemaState>('schema_state').findOne({ _id: SCHEMA_STATE_ID })
  if (existing) {
    if (existing.schemaVersion > AGENT_SCHEMA_VERSION || existing.minimumCompatibleVersion > AGENT_SCHEMA_VERSION) {
      throw new AgentStorageError('unsupported_schema_version', `database schema ${existing.schemaVersion} requires a newer migrator`)
    }
    if (existing.migrationChecksum !== AGENT_MIGRATION_CHECKSUM) {
      throw new AgentStorageError('migration_conflict', 'database migration checksum differs from this release', { databaseChecksum: existing.migrationChecksum, expectedChecksum: AGENT_MIGRATION_CHECKSUM })
    }
  }
  const initial = await initializeState(db)
  if (initial.migrationChecksum !== AGENT_MIGRATION_CHECKSUM) {
    throw new AgentStorageError('migration_conflict', 'database migration checksum differs from this release', { databaseChecksum: initial.migrationChecksum, expectedChecksum: AGENT_MIGRATION_CHECKSUM })
  }
  if (initial.schemaVersion > AGENT_SCHEMA_VERSION || initial.minimumCompatibleVersion > AGENT_SCHEMA_VERSION) {
    throw new AgentStorageError('unsupported_schema_version', `database schema ${initial.schemaVersion} requires a newer migrator`)
  }
  if (initial.schemaVersion === AGENT_SCHEMA_VERSION) {
    if (initial.migrationStatus !== 'ready') throw new AgentStorageError('migration_conflict', `current schema version is not ready: ${initial.migrationStatus}`)
    await verifyStorageCatalog(db)
    return { fromVersion: initial.schemaVersion, toVersion: initial.schemaVersion, applied: false, resumed: false, completedSteps: [] }
  }

  const token = options.migrationToken ?? randomUUID()
  const resumed = initial.migrationStatus === 'interrupted' || initial.migrationStatus === 'running'
  const now = await readServerTime(db)
  const leaseDurationMS = options.leaseDurationMS ?? 30_000
  if (!Number.isInteger(leaseDurationMS) || leaseDurationMS < 100 || leaseDurationMS > 300_000) throw new AgentStorageError('migration_conflict', 'migration lease duration is invalid')
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMS)
  const acquired = await db.collection<SchemaState>('schema_state').updateOne(
    {
      _id: SCHEMA_STATE_ID,
      schemaVersion: initial.schemaVersion,
      migrationChecksum: AGENT_MIGRATION_CHECKSUM,
      $or: [
        { migrationStatus: { $in: ['ready', 'interrupted'] } },
        { migrationStatus: 'running', migrationLeaseExpiresAt: { $lte: now } },
      ],
    },
    { $set: { migrationStatus: 'running', migrationToken: token, migrationLeaseExpiresAt: leaseExpiresAt, updatedAt: now } },
  )
  if (acquired.modifiedCount !== 1) throw new AgentStorageError('migration_conflict', 'another migration owns the schema state')

  const completedSteps: string[] = []
  try {
    const heartbeat = async (): Promise<Date> => {
      const serverNow = await readServerTime(db)
      const nextExpiry = new Date(serverNow.getTime() + leaseDurationMS)
      const result = await db.collection<SchemaState>('schema_state').updateOne(
        { _id: SCHEMA_STATE_ID, schemaVersion: initial.schemaVersion, migrationStatus: 'running', migrationToken: token, migrationChecksum: AGENT_MIGRATION_CHECKSUM },
        { $set: { migrationLeaseExpiresAt: nextExpiry, updatedAt: serverNow } },
      )
      if (result.matchedCount !== 1) throw new AgentStorageError('migration_conflict', 'migration lease was fenced by another migrator')
      return serverNow
    }
    let stepNumber = 0
    for (const definition of AGENT_COLLECTIONS) {
      const collectionStep = `collection:${definition.name}`
      await ensureCollection(db, definition.name)
      completedSteps.push(collectionStep)
      stepNumber += 1
      await db.collection('migration_runs').updateOne(
        { targetVersion: AGENT_SCHEMA_VERSION },
        { $set: { status: 'running', migrationToken: token, migrationChecksum: AGENT_MIGRATION_CHECKSUM, updatedAt: await heartbeat() }, $addToSet: { completedSteps: collectionStep }, $setOnInsert: { startedAt: now } },
        { upsert: true },
      )
      await options.onStep?.(collectionStep, stepNumber)
      if (options.interruptAfterStep === stepNumber) throw new AgentStorageError('migration_interrupted', `migration interrupted after ${collectionStep}`)

      for (const index of definition.indexes) {
        const indexStep = `index:${definition.name}:${index.name}`
        await ensureIndex(db, definition.name, index)
        completedSteps.push(indexStep)
        stepNumber += 1
        await db.collection('migration_runs').updateOne(
          { targetVersion: AGENT_SCHEMA_VERSION },
          { $set: { status: 'running', migrationToken: token, migrationChecksum: AGENT_MIGRATION_CHECKSUM, updatedAt: await heartbeat() }, $addToSet: { completedSteps: indexStep } },
        )
        await options.onStep?.(indexStep, stepNumber)
        if (options.interruptAfterStep === stepNumber) throw new AgentStorageError('migration_interrupted', `migration interrupted after ${indexStep}`)
      }
    }
    await verifyStorageCatalog(db)
    await withAgentTransaction(db, async session => {
      const finishedAt = await readServerTime(db)
      const finalized = await db.collection<SchemaState>('schema_state').updateOne(
        { _id: SCHEMA_STATE_ID, schemaVersion: initial.schemaVersion, migrationStatus: 'running', migrationToken: token },
        { $set: { schemaVersion: AGENT_SCHEMA_VERSION, minimumCompatibleVersion: MINIMUM_COMPATIBLE_SCHEMA_VERSION, migrationStatus: 'ready', migrationChecksum: AGENT_MIGRATION_CHECKSUM, featureCompatibilityVersion: '7.0', updatedAt: finishedAt }, $unset: { migrationToken: '', migrationLeaseExpiresAt: '' } },
        { session },
      )
      if (finalized.modifiedCount !== 1) throw new AgentStorageError('migration_conflict', 'migration lost schema ownership before commit')
      await db.collection('migration_runs').updateOne(
        { targetVersion: AGENT_SCHEMA_VERSION, migrationToken: token },
        { $set: { status: 'complete', completedAt: finishedAt, updatedAt: finishedAt } },
        { session },
      )
      return true
    })
    return { fromVersion: initial.schemaVersion, toVersion: AGENT_SCHEMA_VERSION, applied: true, resumed, completedSteps }
  } catch (error) {
    const interruptedAt = await readServerTime(db)
    await db.collection<SchemaState>('schema_state').updateOne(
      { _id: SCHEMA_STATE_ID, schemaVersion: initial.schemaVersion, migrationToken: token },
      { $set: { migrationStatus: 'interrupted', updatedAt: interruptedAt }, $unset: { migrationToken: '', migrationLeaseExpiresAt: '' } },
    )
    await db.collection('migration_runs').updateOne(
      { targetVersion: AGENT_SCHEMA_VERSION, migrationToken: token },
      { $set: { status: 'interrupted', updatedAt: interruptedAt, errorCode: error instanceof AgentStorageError ? error.code : 'migration_interrupted' } },
    )
    throw error
  }
}

export function bsonInt64(value: number | bigint | string): Long {
  return typeof value === 'bigint' ? Long.fromBigInt(value) : typeof value === 'string' ? Long.fromString(value) : Long.fromNumber(value)
}

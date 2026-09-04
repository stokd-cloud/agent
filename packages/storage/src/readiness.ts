import { randomUUID } from 'node:crypto'
import type { Db } from 'mongodb'
import { MONGODB_FCV, MONGODB_SERVER_VERSION, type NormalizedAgentStorageConfig } from './config.js'
import { AgentStorageError } from './errors.js'

export interface MongoReadiness {
  readonly serverVersion: string
  readonly featureCompatibilityVersion: string | null
  readonly featureCompatibilityVerified: boolean
  readonly replicaSetName: string
  readonly writablePrimary: boolean
  readonly logicalSessionTimeoutMinutes: number
  readonly serverTime: Date
}

interface HelloReply {
  readonly setName?: string
  readonly isWritablePrimary?: boolean
  readonly ismaster?: boolean
  readonly logicalSessionTimeoutMinutes?: number
  readonly localTime?: Date
}

interface BuildInfoReply { readonly version?: string }
interface FcvReply { readonly featureCompatibilityVersion?: { readonly version?: string } | string }

function storageNotReady(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new AgentStorageError('storage_not_ready', message, details)
}

export async function readServerTime(db: Db): Promise<Date> {
  const hello = await db.admin().command({ hello: 1 }) as HelloReply
  if (!(hello.localTime instanceof Date)) storageNotReady('MongoDB hello response omitted server localTime')
  return hello.localTime
}

export async function inspectMongoReadiness(
  db: Db,
  config: Pick<NormalizedAgentStorageConfig, 'expectedReplicaSet' | 'expectedServerVersion' | 'expectedFeatureCompatibilityVersion'> & { readonly managed?: boolean },
  options: { readonly verifyFeatureCompatibilityVersion: boolean },
): Promise<MongoReadiness> {
  const [hello, buildInfo] = await Promise.all([
    db.admin().command({ hello: 1 }) as Promise<HelloReply>,
    db.admin().command({ buildInfo: 1 }) as Promise<BuildInfoReply>,
  ])
  const serverVersion = buildInfo.version ?? ''
  const managed = config.managed === true
  if (managed) {
    // A managed provider upgrades the cluster on its own schedule, so an exact
    // pin fails on a day we did not choose. Assert the floor the schema needs
    // and record what actually answered.
    const [major = 0, minor = 0] = serverVersion.split('.').map(Number)
    const [floorMajor = 0, floorMinor = 0] = config.expectedServerVersion.split('.').map(Number)
    if (!(major > floorMajor || (major === floorMajor && minor >= floorMinor))) {
      throw new AgentStorageError('unsupported_mongodb_version', `MongoDB ${serverVersion || '<unknown>'} is below the required ${config.expectedServerVersion}`, { serverVersion })
    }
  } else if (serverVersion !== config.expectedServerVersion) {
    throw new AgentStorageError('unsupported_mongodb_version', `MongoDB ${serverVersion || '<unknown>'} does not match pinned ${config.expectedServerVersion}`, { serverVersion })
  }
  let featureCompatibilityVersion: string | null = null
  if (options.verifyFeatureCompatibilityVersion && !managed) {
    const fcv = await db.admin().command({ getParameter: 1, featureCompatibilityVersion: 1 }) as FcvReply
    const rawFcv = fcv.featureCompatibilityVersion
    featureCompatibilityVersion = typeof rawFcv === 'string' ? rawFcv : rawFcv?.version ?? ''
    if (featureCompatibilityVersion !== config.expectedFeatureCompatibilityVersion) {
      throw new AgentStorageError('unsupported_mongodb_version', `MongoDB FCV ${featureCompatibilityVersion || '<unknown>'} does not match ${config.expectedFeatureCompatibilityVersion}`, { featureCompatibilityVersion })
    }
  }
  // The managed provider names its own replica set; a writable primary is what
  // actually matters and is still required below.
  // A replica set is required either way -- transactions depend on it. Only the
  // NAME is the managed provider's to choose.
  if (typeof hello.setName !== 'string' || hello.setName === '') storageNotReady('MongoDB connection is not a replica set')
  if (!managed && hello.setName !== config.expectedReplicaSet) storageNotReady(`MongoDB replica set ${hello.setName} does not match ${config.expectedReplicaSet}`)
  const writablePrimary = hello.isWritablePrimary === true || hello.ismaster === true
  if (!writablePrimary) storageNotReady('MongoDB connection is not a writable replica-set primary')
  const logicalSessionTimeoutMinutes = hello.logicalSessionTimeoutMinutes
  if (!Number.isInteger(logicalSessionTimeoutMinutes) || (logicalSessionTimeoutMinutes ?? 0) <= 0) {
    storageNotReady('MongoDB logical sessions are unavailable')
  }
  if (!(hello.localTime instanceof Date)) storageNotReady('MongoDB hello response omitted server localTime')
  return {
    serverVersion,
    featureCompatibilityVersion,
    featureCompatibilityVerified: options.verifyFeatureCompatibilityVersion,
    replicaSetName: hello.setName,
    writablePrimary,
    logicalSessionTimeoutMinutes: logicalSessionTimeoutMinutes!,
    serverTime: hello.localTime,
  }
}

export function inspectMongoServiceReadiness(
  db: Db,
  config: Pick<NormalizedAgentStorageConfig, 'expectedReplicaSet' | 'expectedServerVersion' | 'expectedFeatureCompatibilityVersion'>,
): Promise<MongoReadiness> {
  return inspectMongoReadiness(db, config, { verifyFeatureCompatibilityVersion: false })
}

export function inspectMongoMigrationReadiness(
  db: Db,
  config: Pick<NormalizedAgentStorageConfig, 'expectedReplicaSet' | 'expectedServerVersion' | 'expectedFeatureCompatibilityVersion'>,
): Promise<MongoReadiness> {
  return inspectMongoReadiness(db, config, { verifyFeatureCompatibilityVersion: true })
}

export async function assertTransactionSupport(db: Db): Promise<void> {
  const session = db.client.startSession({ causalConsistency: true })
  const probeId = `transaction-${randomUUID()}`
  try {
    await session.withTransaction(async () => {
      await db.collection<{ _id: string; probe?: boolean }>('schema_state').updateOne(
        { _id: probeId },
        { $set: { probe: true } },
        { upsert: true, session },
      )
      await db.collection<{ _id: string; probe?: boolean }>('schema_state').deleteOne({ _id: probeId }, { session })
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority', j: true },
      readPreference: 'primary',
      maxCommitTimeMS: 10_000,
    })
  } catch (error) {
    throw new AgentStorageError('storage_not_ready', 'MongoDB transaction probe failed', { cause: error instanceof Error ? error.message : String(error) })
  } finally {
    await session.endSession()
  }
}

export const PINNED_READINESS = {
  serverVersion: MONGODB_SERVER_VERSION,
  featureCompatibilityVersion: MONGODB_FCV,
  requiresReplicaSet: true,
  requiresWritablePrimary: true,
  requiresLogicalSessions: true,
  requiresTransactions: true,
} as const

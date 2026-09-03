import type { Db, Document, Filter } from 'mongodb'
import { Long, MongoServerError } from 'mongodb'
import { AgentStorageError } from './errors.js'
import { readServerTime } from './readiness.js'

export interface CoordinatorLease extends Document {
  readonly _id: string
  readonly agentId: string
  readonly holderId: string
  readonly generation: Long
  readonly leaseIssuedAt: Date
  readonly leaseExpiresAt: Date
  readonly status: 'active' | 'released'
}

export interface LeaseGrant {
  readonly agentId: string
  readonly holderId: string
  readonly generation: Long
  readonly serverTime: Date
  readonly leaseExpiresAt: Date
}

const DEFAULT_LEASE_SECONDS = 45

function grant(document: CoordinatorLease, serverTime: Date): LeaseGrant {
  return { agentId: document.agentId, holderId: document.holderId, generation: document.generation, serverTime, leaseExpiresAt: document.leaseExpiresAt }
}

export async function acquireCoordinatorLease(db: Db, agentId: string, holderId: string, leaseSeconds = DEFAULT_LEASE_SECONDS): Promise<LeaseGrant> {
  if (!agentId || !holderId || !Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) throw new AgentStorageError('stale_fence', 'lease input is invalid')
  const serverTime = await readServerTime(db)
  const leaseExpiresAt = new Date(serverTime.getTime() + leaseSeconds * 1000)
  const collection = db.collection<CoordinatorLease>('coordinator_leases')
  const filter: Filter<CoordinatorLease> = {
    _id: agentId,
    $or: [
      { holderId, status: 'active' },
      { leaseExpiresAt: { $lte: serverTime } },
      { status: 'released' },
    ],
  }
  const update = [{
    $set: {
      agentId,
      holderId,
      generation: { $add: [{ $ifNull: ['$generation', Long.ZERO] }, Long.ONE] },
      leaseIssuedAt: '$$NOW',
      leaseExpiresAt: { $dateAdd: { startDate: '$$NOW', unit: 'second', amount: leaseSeconds } },
      status: 'active',
    },
  }]
  const existing = await collection.findOneAndUpdate(filter, update, { returnDocument: 'after' })
  if (existing) return grant(existing, await readServerTime(db))
  try {
    const inserted: CoordinatorLease = { _id: agentId, agentId, holderId, generation: Long.ONE, leaseIssuedAt: serverTime, leaseExpiresAt, status: 'active' }
    await collection.insertOne(inserted)
    return grant(inserted, serverTime)
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) throw new AgentStorageError('stale_fence', 'coordinator lease is held by another generation', { agentId })
    throw error
  }
}

export async function renewCoordinatorLease(db: Db, grantValue: Pick<LeaseGrant, 'agentId' | 'holderId' | 'generation'>, leaseSeconds = DEFAULT_LEASE_SECONDS): Promise<LeaseGrant> {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) throw new AgentStorageError('stale_fence', 'lease duration is invalid')
  const serverTime = await readServerTime(db)
  const result = await db.collection<CoordinatorLease>('coordinator_leases').findOneAndUpdate(
    { _id: grantValue.agentId, holderId: grantValue.holderId, generation: grantValue.generation, status: 'active', leaseExpiresAt: { $gt: serverTime } },
    [{ $set: { leaseIssuedAt: '$$NOW', leaseExpiresAt: { $dateAdd: { startDate: '$$NOW', unit: 'second', amount: leaseSeconds } } } }],
    { returnDocument: 'after' },
  )
  if (!result) throw new AgentStorageError('stale_fence', 'coordinator lease renewal was fenced', { agentId: grantValue.agentId, generation: grantValue.generation.toString() })
  return grant(result, await readServerTime(db))
}

export async function assertCoordinatorFence(db: Db, grantValue: Pick<LeaseGrant, 'agentId' | 'holderId' | 'generation'>): Promise<void> {
  const serverTime = await readServerTime(db)
  const match = await db.collection<CoordinatorLease>('coordinator_leases').findOne({
    _id: grantValue.agentId,
    holderId: grantValue.holderId,
    generation: grantValue.generation,
    status: 'active',
    leaseExpiresAt: { $gt: serverTime },
  })
  if (!match) throw new AgentStorageError('stale_fence', 'coordinator generation is stale or expired', { agentId: grantValue.agentId, generation: grantValue.generation.toString() })
}

export async function releaseCoordinatorLease(db: Db, grantValue: Pick<LeaseGrant, 'agentId' | 'holderId' | 'generation'>): Promise<void> {
  const serverTime = await readServerTime(db)
  const result = await db.collection<CoordinatorLease>('coordinator_leases').updateOne(
    { _id: grantValue.agentId, holderId: grantValue.holderId, generation: grantValue.generation, status: 'active' },
    { $set: { status: 'released', leaseExpiresAt: serverTime } },
  )
  if (result.modifiedCount !== 1) throw new AgentStorageError('stale_fence', 'coordinator lease release was fenced', { agentId: grantValue.agentId })
}

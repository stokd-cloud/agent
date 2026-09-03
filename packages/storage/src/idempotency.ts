import { createHash, randomUUID } from 'node:crypto'
import type { ClientSession, Db, Document } from 'mongodb'
import { MongoServerError } from 'mongodb'
import { AgentStorageError } from './errors.js'
import { readServerTime } from './readiness.js'

export interface IdempotencyReceipt extends Document {
  readonly _id: string
  readonly ownerSubject: string
  readonly scope: string
  readonly idempotencyKey: string
  readonly commandId: string
  readonly requestSha256: string
  readonly state: 'claimed' | 'completed' | 'failed'
  readonly response?: unknown
  readonly responseSha256?: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface IdempotencyClaim {
  readonly receipt: IdempotencyReceipt
  readonly replay: boolean
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function contentSha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export async function claimIdempotencyReceipt(
  db: Db,
  input: {
    readonly ownerSubject: string
    readonly scope: string
    readonly idempotencyKey: string
    readonly commandId: string
    readonly request: unknown
  },
  session?: ClientSession,
): Promise<IdempotencyClaim> {
  for (const [name, value] of Object.entries(input).filter(([name]) => name !== 'request')) {
    if (typeof value !== 'string' || value.length === 0) throw new AgentStorageError('idempotency_conflict', `${name} is required`)
  }
  const requestSha256 = contentSha256(input.request)
  const now = await readServerTime(db)
  const receipt: IdempotencyReceipt = {
    _id: `receipt-${randomUUID()}`,
    ownerSubject: input.ownerSubject,
    scope: input.scope,
    idempotencyKey: input.idempotencyKey,
    commandId: input.commandId,
    requestSha256,
    state: 'claimed',
    createdAt: now,
    updatedAt: now,
  }
  try {
    const existing = await db.collection<IdempotencyReceipt>('idempotency_receipts').findOneAndUpdate(
      { ownerSubject: input.ownerSubject, scope: input.scope, idempotencyKey: input.idempotencyKey },
      { $setOnInsert: receipt },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false, ...(session ? { session } : {}) },
    )
    if (!existing || existing.ownerSubject !== input.ownerSubject || existing.scope !== input.scope || existing.idempotencyKey !== input.idempotencyKey || existing.commandId !== input.commandId || existing.requestSha256 !== requestSha256) {
      throw new AgentStorageError('idempotency_conflict', 'idempotency key was reused with different content', { commandId: input.commandId })
    }
    return { receipt: existing, replay: existing._id !== receipt._id }
  } catch (error) {
    if (error instanceof AgentStorageError) throw error
    if (error instanceof MongoServerError && error.code === 11000) {
      throw new AgentStorageError('idempotency_conflict', 'command ID was reused by a different idempotency key', { commandId: input.commandId })
    }
    throw error
  }
}

export async function completeIdempotencyReceipt(db: Db, receiptId: string, response: unknown, session?: ClientSession): Promise<IdempotencyReceipt> {
  const now = await readServerTime(db)
  const result = await db.collection<IdempotencyReceipt>('idempotency_receipts').findOneAndUpdate(
    { _id: receiptId, state: 'claimed' },
    { $set: { state: 'completed', response, responseSha256: contentSha256(response), updatedAt: now } },
    { returnDocument: 'after', ...(session ? { session } : {}) },
  )
  if (!result) throw new AgentStorageError('idempotency_conflict', 'idempotency receipt is missing or already terminal', { receiptId })
  return result
}

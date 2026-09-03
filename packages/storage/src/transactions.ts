import type { ClientSession, Db, Document, Filter, OptionalUnlessRequiredId, UpdateFilter, WithId } from 'mongodb'
import { Long } from 'mongodb'
import { AgentStorageError } from './errors.js'

export const AGENT_TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const, j: true },
  readPreference: 'primary' as const,
  maxCommitTimeMS: 10_000,
}

export async function withAgentTransaction<T>(db: Db, operation: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = db.client.startSession({ causalConsistency: true })
  try {
    let result: T | undefined
    await session.withTransaction(async () => { result = await operation(session) }, AGENT_TRANSACTION_OPTIONS)
    return result as T
  } finally {
    await session.endSession()
  }
}

export interface RevisionedDocument extends Document {
  readonly _id: string
  readonly ownerSubject: string
  readonly revision: Long
}

export async function insertRevisioned<T extends RevisionedDocument>(db: Db, collectionName: string, document: Omit<T, 'revision'> & { readonly revision?: never }): Promise<T> {
  const value = { ...document, revision: Long.ONE } as unknown as OptionalUnlessRequiredId<T>
  await db.collection<T>(collectionName).insertOne(value, { writeConcern: { w: 'majority', j: true } })
  return value as T
}

export async function compareAndSwapRevision<T extends RevisionedDocument>(
  db: Db,
  collectionName: string,
  id: string,
  ownerSubject: string,
  expectedRevision: Long,
  update: UpdateFilter<T>,
  session?: ClientSession,
): Promise<WithId<T>> {
  const filter = { _id: id, ownerSubject, revision: expectedRevision } as Filter<T>
  const callerIncrement = (update.$inc ?? {}) as Readonly<Record<string, unknown>>
  const updateWithRevision = { ...update, $inc: { ...callerIncrement, revision: Long.ONE } } as unknown as UpdateFilter<T>
  const result = await db.collection<T>(collectionName).findOneAndUpdate(
    filter,
    updateWithRevision,
    { returnDocument: 'after', ...(session ? { session } : {}) },
  )
  if (!result) {
    throw new AgentStorageError('revision_conflict', 'revision compare-and-swap failed', { collectionName, id, expectedRevision: expectedRevision.toString() })
  }
  return result
}

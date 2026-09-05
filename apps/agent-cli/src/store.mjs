// Durable state for agents that outlive any single session.
//
// The whole point of this package is that a conversation can run forever
// without the context window growing. That needs three things kept apart:
//   messages  -- the complete transcript, never truncated, never sent whole
//   summaries -- rolling compaction of transcript ranges already folded away
//   memories  -- durable facts lifted out of the transcript, retrieved by need
import { MongoClient } from 'mongodb'

const URI = process.env.STOKD_AGENT_MONGO_URI ?? 'mongodb://127.0.0.1:27017'
const DB = process.env.STOKD_AGENT_DB ?? 'stokd-agent'

let client
export async function store() {
  if (!client) {
    client = new MongoClient(URI)
    await client.connect()
  }
  const db = client.db(DB)
  const agents = db.collection('agents')
  const conversations = db.collection('conversations')
  const messages = db.collection('messages')
  const summaries = db.collection('summaries')
  const memories = db.collection('memories')

  await agents.createIndex({ name: 1 }, { unique: true })
  await conversations.createIndex({ agentId: 1, updatedAt: -1 })
  await messages.createIndex({ conversationId: 1, seq: 1 }, { unique: true })
  await summaries.createIndex({ conversationId: 1, throughSeq: 1 })
  // Retrieval is keyword-based on purpose: it needs no embedding provider, so
  // an agent recalls things with nothing configured beyond a local database.
  await memories.createIndex({ content: 'text' })
  await memories.createIndex({ agentId: 1, updatedAt: -1 })

  return { db, agents, conversations, messages, summaries, memories, close: () => client.close() }
}

export function now() { return new Date() }
export function id(prefix) { return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}` }

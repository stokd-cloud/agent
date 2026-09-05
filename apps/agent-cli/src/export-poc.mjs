// Read-only Mongo transport adapter. Rust validates and imports the snapshot in
// one transaction. This adapter never creates indexes or modifies collections.
import { MongoClient } from 'mongodb'

export async function exportPoc() {
  const client = new MongoClient(process.env.STOKD_AGENT_MONGO_URI ?? 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 5000 })
  const database = process.env.STOKD_AGENT_DB ?? 'stokd-agent'
  try {
    await client.connect()
    const db = client.db(database)
    const names = ['agents', 'conversations', 'messages', 'summaries', 'memories']
    const collections = await Promise.all(names.map(name => db.collection(name).find({}).sort(name === 'messages' ? { conversationId: 1, seq: 1 } : { _id: 1 }).toArray()))
    return { source: `mongo-poc:${database}`, data: Object.fromEntries(names.map((name, i) => [name, collections[i]])) }
  } catch { throw new Error('Cannot read the Mongo PoC. Check STOKD_AGENT_MONGO_URI and STOKD_AGENT_DB; source data was not changed.') }
  finally { await client.close() }
}

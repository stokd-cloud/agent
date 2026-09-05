// One turn, end to end. Everything the viability claim rests on happens here.
import { store, now, id } from './store.mjs'
import { ask, tokens } from './model.mjs'
import { assemble, recallMemories, recentMessages, runningSummary } from './context.mjs'
import { compact, extractMemories } from './memory.mjs'

export function normalize(name) {
  return String(name).normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '-')
}

export async function createAgent(s, { name, identity }) {
  const key = normalize(name)
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(key)) throw new Error('name must be letters, digits and dashes')
  const existing = await s.agents.findOne({ name: key })
  if (existing) throw new Error(`agent '${key}' already exists`)
  const doc = {
    _id: id('agt'), name: key, displayName: String(name).trim(),
    identity: identity ?? `You are ${String(name).trim()}, a persistent assistant who remembers this person across every conversation.`,
    createdAt: now(), updatedAt: now(),
  }
  await s.agents.insertOne(doc)
  return doc
}

export async function openConversation(s, agent, conversationId) {
  if (conversationId) {
    const found = await s.conversations.findOne({ _id: conversationId, agentId: agent._id })
    if (!found) throw new Error('conversation not found for this agent')
    return found
  }
  const latest = await s.conversations.find({ agentId: agent._id }).sort({ updatedAt: -1 }).limit(1).next()
  if (latest) return latest
  const doc = { _id: id('cnv'), agentId: agent._id, title: 'conversation', createdAt: now(), updatedAt: now(), seq: 0 }
  await s.conversations.insertOne(doc)
  return doc
}

async function append(s, conversation, role, content) {
  const next = await s.conversations.findOneAndUpdate(
    { _id: conversation._id }, { $inc: { seq: 1 }, $set: { updatedAt: now() } }, { returnDocument: 'after' },
  )
  const seq = next.seq
  await s.messages.insertOne({ _id: id('msg'), conversationId: conversation._id, agentId: conversation.agentId, seq, role, content, createdAt: now() })
  return seq
}

export async function turn(s, agent, conversation, input, { onStage } = {}) {
  const stage = onStage ?? (() => {})

  stage('recall')
  const [memories, summary, recent] = await Promise.all([
    recallMemories(s, agent._id, input),
    runningSummary(s, conversation._id),
    recentMessages(s, conversation._id),
  ])

  const { prompt, estimatedTokens } = assemble({ agent, memories, summary, recent, input })

  stage('think')
  const reply = await ask(prompt)

  await append(s, conversation, 'user', input)
  await append(s, conversation, 'assistant', reply)

  // Learning happens after the reply so it never delays the answer.
  stage('learn')
  const learned = await extractMemories(s, agent, { input, reply }).catch(() => [])
  const folded = await compact(s, conversation, agent).catch(() => null)

  const total = await s.messages.countDocuments({ conversationId: conversation._id })
  return {
    reply,
    telemetry: {
      promptTokens: estimatedTokens,
      recalled: memories.length,
      learned: learned.length,
      totalMessages: total,
      summarizedThrough: folded ? folded.throughSeq : (summary?.throughSeq ?? 0),
      compacted: Boolean(folded),
    },
  }
}

export { store, tokens }

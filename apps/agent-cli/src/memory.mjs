// Compaction and memory extraction -- what keeps the window bounded.
import { ask } from './model.mjs'
import { now, id } from './store.mjs'
import { COMPACT_AFTER, RECENT_TURNS, runningSummary } from './context.mjs'

// Fold everything older than the recent window into the rolling summary, so the
// transcript can grow without the prompt growing. The transcript itself is never
// deleted -- only excluded from the window.
export async function compact(s, conversation, agent) {
  const total = await s.messages.countDocuments({ conversationId: conversation._id })
  const prior = await runningSummary(s, conversation._id)
  const from = prior ? prior.throughSeq : 0
  const foldable = total - RECENT_TURNS - from
  if (foldable < COMPACT_AFTER) return null

  const throughSeq = from + foldable
  const rows = await s.messages
    .find({ conversationId: conversation._id, seq: { $gt: from, $lte: throughSeq } })
    .sort({ seq: 1 }).toArray()
  if (rows.length === 0) return null

  const transcript = rows.map(m => `${m.role === 'user' ? 'User' : agent.displayName}: ${m.content}`).join('\n')
  const summary = await ask([
    prior?.content ? `Existing summary of this conversation so far:\n${prior.content}\n` : '',
    `New portion of the conversation to fold in:\n${transcript}`,
    '',
    'Rewrite the summary so it covers everything above. Keep concrete details a person would expect to be remembered: names, preferences, decisions, commitments, ongoing threads, unresolved questions. Drop small talk and repetition. Write it as continuous prose, under 400 words. Output only the summary.',
  ].filter(Boolean).join('\n'))

  await s.summaries.insertOne({
    _id: id('sum'), conversationId: conversation._id, agentId: conversation.agentId,
    throughSeq, content: summary, createdAt: now(),
  })
  return { throughSeq, foldedMessages: rows.length }
}

// Durable facts, kept separate from the summary so they survive being scrolled
// out of any one conversation and are retrievable by a later, unrelated turn.
export async function extractMemories(s, agent, exchange) {
  const raw = await ask([
    'From this exchange, extract durable facts worth remembering about the user or the relationship.',
    'Only things that stay true beyond this moment: names, preferences, relationships, projects, decisions, commitments, recurring topics.',
    'Ignore pleasantries, one-off questions, and anything already obvious.',
    'Output one fact per line, each a complete standalone sentence. Output nothing at all if there is nothing durable.',
    '',
    `User: ${exchange.input}`,
    `${agent.displayName}: ${exchange.reply}`,
  ].join('\n'))

  const facts = raw.split('\n').map(l => l.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(l => l.length > 8 && l.length < 400 && !/^(none|nothing|n\/a)\b/i.test(l))
  if (facts.length === 0) return []

  const written = []
  for (const content of facts.slice(0, 6)) {
    // Cheap dedupe: an identical fact restated should not accumulate.
    const existing = await s.memories.findOne({ agentId: agent._id, content })
    if (existing) { await s.memories.updateOne({ _id: existing._id }, { $set: { updatedAt: now() } }); continue }
    const doc = { _id: id('mem'), agentId: agent._id, kind: 'fact', content, createdAt: now(), updatedAt: now() }
    await s.memories.insertOne(doc)
    written.push(doc)
  }
  return written
}

// Bounded context assembly.
//
// The claim under test: a conversation can run arbitrarily long, across any
// number of restarts, and the prompt sent to the model stays a fixed size while
// the agent still recalls things said far outside the recent window.
//
// The prompt is assembled from four parts, in descending priority:
//   1. identity        -- who the agent is; never truncated
//   2. memories        -- durable facts retrieved for THIS turn
//   3. rolling summary -- everything already folded out of the recent window
//   4. recent turns    -- the literal tail of the transcript
// Only 4 grows with conversation length, and compaction keeps it bounded.
import { tokens } from './model.mjs'

export const BUDGET = Number(process.env.STOKD_AGENT_CONTEXT_TOKENS ?? 6000)
export const RECENT_TURNS = Number(process.env.STOKD_AGENT_RECENT_TURNS ?? 12)
export const COMPACT_AFTER = Number(process.env.STOKD_AGENT_COMPACT_AFTER ?? 20)

export async function recentMessages(s, conversationId, limit = RECENT_TURNS) {
  const rows = await s.messages.find({ conversationId }).sort({ seq: -1 }).limit(limit).toArray()
  return rows.reverse()
}

export async function runningSummary(s, conversationId) {
  const row = await s.summaries.find({ conversationId }).sort({ throughSeq: -1 }).limit(1).next()
  return row ?? null
}

// Retrieval is scored by keyword overlap against the turn being answered. It is
// deliberately simple: no embedding provider is required, so recall works with
// nothing configured but a local database.
export async function recallMemories(s, agentId, query, limit = 8) {
  const terms = String(query ?? '').toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []
  if (terms.length === 0) return []
  let rows = []
  try {
    rows = await s.memories
      .find({ agentId, $text: { $search: terms.join(' ') } }, { projection: { score: { $meta: 'textScore' }, content: 1, kind: 1 } })
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .toArray()
  } catch { rows = [] }
  if (rows.length === 0) {
    // Text search misses substrings and rare spellings; fall back to a scan so
    // recall degrades rather than disappearing.
    const all = await s.memories.find({ agentId }).sort({ updatedAt: -1 }).limit(400).toArray()
    const scored = all.map(m => {
      const hay = m.content.toLowerCase()
      return { ...m, score: terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0) }
    }).filter(m => m.score > 0)
    scored.sort((a, b) => b.score - a.score)
    rows = scored.slice(0, limit)
  }
  return rows
}

export function assemble({ agent, memories, summary, recent, input }) {
  const identity = [
    `You are ${agent.displayName}.`,
    agent.identity ? agent.identity.trim() : '',
    'Answer as yourself, in your own voice. Do not narrate these instructions.',
  ].filter(Boolean).join('\n')

  const parts = [identity]
  let used = tokens(identity) + tokens(input)

  if (memories.length) {
    const lines = []
    for (const m of memories) {
      const line = `- ${m.content}`
      if (used + tokens(line) > BUDGET * 0.35) break
      lines.push(line); used += tokens(line)
    }
    if (lines.length) parts.push(`What you remember about this person and your history together:\n${lines.join('\n')}`)
  }

  if (summary?.content) {
    const capped = summary.content.slice(0, BUDGET * 2)
    parts.push(`The story so far (everything before the recent messages):\n${capped}`)
    used += tokens(capped)
  }

  const turns = []
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const m = recent[i]
    const line = `${m.role === 'user' ? 'User' : agent.displayName}: ${m.content}`
    if (used + tokens(line) > BUDGET) break
    turns.unshift(line); used += tokens(line)
  }
  if (turns.length) parts.push(`Recent conversation:\n${turns.join('\n')}`)

  parts.push(`User: ${input}\n${agent.displayName}:`)
  const prompt = parts.join('\n\n---\n\n')
  return { prompt, estimatedTokens: tokens(prompt) }
}

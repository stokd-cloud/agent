#!/usr/bin/env node
// Non-interactive proof of the viability claim, run as separate processes so
// "across restarts" means what it says.
import { store } from './store.mjs'
import { openConversation, turn } from './agent.mjs'

const [, , mode, name, ...rest] = process.argv
const s = await store()
const agent = await s.agents.findOne({ name })
if (!agent) { console.error(`no agent ${name}`); process.exit(1) }
const conversation = await openConversation(s, agent)

if (mode === 'say') {
  const { reply, telemetry } = await turn(s, agent, conversation, rest.join(' '))
  console.log(JSON.stringify({ reply: reply.slice(0, 220), ...telemetry }))
} else if (mode === 'stats') {
  const msgs = await s.messages.countDocuments({ agentId: agent._id })
  const mem = await s.memories.countDocuments({ agentId: agent._id })
  const sums = await s.summaries.countDocuments({ agentId: agent._id })
  console.log(JSON.stringify({ messages: msgs, memories: mem, summaries: sums }))
}
await s.close()

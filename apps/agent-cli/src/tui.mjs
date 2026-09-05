// Terminal chat. Deliberately plain: readline, ANSI colour, a status line. The
// thing being proven is recall across restarts, not the rendering.
import readline from 'node:readline'
import { openConversation, turn } from './agent.mjs'
import { recentMessages } from './context.mjs'

const c = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
}

export async function chat(s, agent, { conversationId } = {}) {
  const conversation = await openConversation(s, agent, conversationId)
  const history = await recentMessages(s, conversation._id, 6)
  const total = await s.messages.countDocuments({ conversationId: conversation._id })
  const remembered = await s.memories.countDocuments({ agentId: agent._id })

  console.log(c.bold(`\n  ${agent.displayName}`))
  console.log(c.dim(`  ${total} messages in this conversation · ${remembered} things remembered · ${conversation._id}`))
  if (history.length) {
    console.log(c.dim('  ── picking up where you left off ──'))
    for (const m of history.slice(-4)) {
      const who = m.role === 'user' ? 'you' : agent.displayName
      const text = m.content.length > 160 ? `${m.content.slice(0, 160)}…` : m.content
      console.log(c.dim(`  ${who}: ${text.replace(/\n/g, ' ')}`))
    }
  }
  console.log(c.dim('  /exit to leave · /new for a fresh conversation · /memories to inspect recall\n'))

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.cyan('you › ') })
  rl.prompt()

  let current = conversation
  for await (const line of rl) {
    const input = line.trim()
    if (!input) { rl.prompt(); continue }
    if (input === '/exit' || input === '/quit') break
    if (input === '/new') {
      const doc = { _id: `cnv_${Date.now().toString(36)}`, agentId: agent._id, title: 'conversation', createdAt: new Date(), updatedAt: new Date(), seq: 0 }
      await s.conversations.insertOne(doc)
      current = doc
      console.log(c.dim(`  new conversation ${doc._id}\n`))
      rl.prompt(); continue
    }
    if (input === '/memories') {
      const rows = await s.memories.find({ agentId: agent._id }).sort({ updatedAt: -1 }).limit(20).toArray()
      console.log(c.dim(`\n  ${rows.length} most recent memories:`))
      for (const m of rows) console.log(c.dim(`  · ${m.content}`))
      console.log()
      rl.prompt(); continue
    }

    process.stdout.write(c.dim('  thinking…'))
    const started = Date.now()
    try {
      const { reply, telemetry } = await turn(s, agent, current, input, {
        onStage: stage => process.stdout.write(c.dim(`\r  ${stage}…      `)),
      })
      process.stdout.write('\r' + ' '.repeat(40) + '\r')
      console.log(`${c.green(agent.displayName)} › ${reply}\n`)
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      console.log(c.dim(`  ${telemetry.promptTokens} prompt tokens · recalled ${telemetry.recalled} · learned ${telemetry.learned} · ${telemetry.totalMessages} msgs total${telemetry.compacted ? ' · compacted' : ''} · ${seconds}s\n`))
    } catch (error) {
      process.stdout.write('\r' + ' '.repeat(40) + '\r')
      console.log(c.yellow(`  ${error.message}\n`))
    }
    rl.prompt()
  }
  rl.close()
}

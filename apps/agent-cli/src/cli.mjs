#!/usr/bin/env node
// stokd-agent create <name>   -- create an agent and install a shim named <name>
// stokd-agent list            -- list agents
// stokd-agent chat <name>     -- open the TUI
// <name>                 -- the installed shim; equivalent to `stokd-agent chat <name>`
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { store } from './store.mjs'
import { createAgent, normalize } from './agent.mjs'
import { chat } from './tui.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SHIM_DIR = process.env.STOKD_AGENT_BIN_DIR ?? join(homedir(), '.local', 'bin')

// Never clobber a command that already exists. Another tool almost certainly
// owns it, and overwriting it silently breaks something the user relies on.
function reserveShim(name) {
  const path = join(SHIM_DIR, name)
  if (existsSync(path)) throw new Error(`'${name}' already exists at ${path} — pick another name`)
  return path
}

function installShim(name) {
  mkdirSync(SHIM_DIR, { recursive: true })
  const path = join(SHIM_DIR, name)
  // Absolute interpreter path: the user's shell does not necessarily have the
  // same node on PATH that created this agent.
  writeFileSync(path, `#!/usr/bin/env bash\nexec ${process.execPath} ${resolve(here, 'cli.mjs')} chat ${name} "$@"\n`, { mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

async function main(argv) {
  const [command, ...rest] = argv
  const s = await store()
  try {
    if (command === 'create') {
      const name = rest[0]
      if (!name) throw new Error('usage: stokd-agent create <name>')
      const identityFlag = rest.indexOf('--identity')
      const identity = identityFlag >= 0 ? rest[identityFlag + 1] : undefined
      // Check the shim name BEFORE writing anything: a collision must not leave
      // a half-created agent behind.
      reserveShim(normalize(name))
      const agent = await createAgent(s, { name, identity })
      const shim = installShim(agent.name)
      console.log(`created ${agent.displayName}`)
      console.log(`run it with: ${agent.name}`)
      if (!process.env.PATH?.split(':').includes(SHIM_DIR)) console.log(`(add ${SHIM_DIR} to PATH)`)
      console.log(`shim: ${shim}`)
      return 0
    }
    if (command === 'list') {
      const rows = await s.agents.find({}).sort({ createdAt: 1 }).toArray()
      if (rows.length === 0) { console.log('no agents yet — stokd-agent create <name>'); return 0 }
      for (const a of rows) {
        const msgs = await s.messages.countDocuments({ agentId: a._id })
        const mem = await s.memories.countDocuments({ agentId: a._id })
        console.log(`${a.name.padEnd(20)} ${String(msgs).padStart(6)} msgs  ${String(mem).padStart(5)} memories`)
      }
      return 0
    }
    if (command === 'chat') {
      const name = normalize(rest[0] ?? '')
      const agent = await s.agents.findOne({ name })
      if (!agent) throw new Error(`no agent named '${name}'`)
      await chat(s, agent)
      return 0
    }
    console.log('usage: stokd-agent create <name> | list | chat <name>')
    return 2
  } finally {
    await s.close()
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})

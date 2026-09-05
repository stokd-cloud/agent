#!/usr/bin/env node
// Presentation and routing only. All domain mutations live in the Rust engine.
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR ??= process.stdout.isTTY ? '3' : '0'

async function main() {
  const { EngineTransport } = await import('../lib/types/stokd/transport.js')
  const transport = new EngineTransport()
  try {
    const result = await transport.request('route.cli', { args: process.argv.slice(2) })
    if (result.view === 'view.chat') {
      const { chat } = await import('../lib/types/stokd/main.js')
      await chat(transport, result.params.agent, result.params.fullscreen)
    } else if (result.view === 'legacy.export') {
      const { exportPoc } = await import('../apps/agent-cli/src/export-poc.mjs')
      const imported = await transport.request('legacy.import', await exportPoc())
      process.stdout.write(JSON.stringify(imported.value, null, 2) + '\n')
    } else if (result.method === 'system.help') process.stdout.write(result.value.text + '\n')
    else process.stdout.write(JSON.stringify(result.value, null, 2) + '\n')
  } finally { await transport.close() }
}

main().catch(error => {
  process.stderr.write(`${error.code === 'ERR_MODULE_NOT_FOUND' ? 'Build the agent first with pnpm build:agent. ' : ''}${error.message}\n`)
  process.exitCode = 1
})

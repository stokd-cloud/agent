import React from 'react'
import { render } from '../ui.js'
import { setLang } from '../i18n.js'
import { AgentChat } from './Chat.js'
import { AgentChannel } from './channel.js'
import type { EngineTransport } from './transport.js'

/** Mount the donor renderer with the Rust channel; no Cordis/native services. */
export async function chat(transport: EngineTransport, name: string, fullscreen: boolean): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive chat requires a TTY. Use stokd-agent command or rpc for headless access.')
  setLang('en')
  const channel = new AgentChannel(transport, name)
  try {
    await channel.start()
    const app = await render(<AgentChat channel={channel} fullscreen={fullscreen} />, { exitOnCtrlC: false, patchConsole: false })
    let failure: Error | undefined
    channel.onExit = () => app.unmount()
    channel.onFailure = error => { failure = error; app.unmount() }
    const stop = () => app.unmount()
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    try { await app.waitUntilExit(); if (failure) throw failure }
    finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); app.unmount(); app.cleanup() }
  } finally { channel.dispose() }
}

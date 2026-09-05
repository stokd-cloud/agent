/** Bounded Stokd integration regression. Build Rust first; runs fake HTTP
 * inference plus the real donor renderer against temporary durable storage.
 * Run: node --import tsx/esm scripts/verify-stokd.tsx */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

const [{ default: assert }, fs, os, path, http, { PassThrough, Writable }, React, { Terminal }, { render }, { EngineTransport }, { AgentChannel }, { AgentChat }, { setLang }] = await Promise.all([
  import('node:assert/strict'), import('node:fs/promises'), import('node:os'), import('node:path'), import('node:http'), import('node:stream'), import('react'), import('@xterm/headless'), import('../src/ui.js'), import('../src/stokd/transport.js'), import('../src/stokd/channel.js'), import('../src/stokd/Chat.js'), import('../src/i18n.js'),
])
import type { Snapshot, Memory, RoutedResult, Transport } from '../src/stokd/protocol.js'
import type { AddressInfo } from 'node:net'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await sleep(20) }
  throw new Error(`Timed out: ${label}`)
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stokd agent 'test-"))
const calls: Array<{ model: string; messages: Array<{ content: string }> }> = []
const server = http.createServer(async (req, res) => {
  let input = ''
  for await (const chunk of req) input += String(chunk)
  const body = JSON.parse(input)
  if (req.url?.endsWith('/embeddings')) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: body.input.map((text: string, index: number) => ({ index, embedding: text.includes('compass') ? [1, 0, 0] : [0, 1, 0] })) }))
    return
  }
  calls.push(body)
  if (body.model === 'broken') { res.writeHead(503); res.end('deliberately unavailable'); return }
  const prompt = body.messages[0].content as string
  if (prompt.includes('Current user message:\nWAIT\n')) return // cancelled by client
  const text = prompt.startsWith('Extract durable') ? '["The user named their compass Juniper."]'
    : prompt.startsWith('Rewrite this rolling') ? 'The user named their compass Juniper.'
    : JSON.stringify({ reply: 'I remember **Juniper**. We can plan the route together.', actions: [{ kind: 'artifact.create', title: 'Journey plan', content: '# Journey\n\nFollow the river north.' }] })
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ choices: [{ message: { content: text } }] }))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
const config = path.join(dir, 'config.json')
await fs.writeFile(config, JSON.stringify({
  providers: [{ name: 'fixture', endpoint, models: ['broken', 'working'] }],
  models: { workloads: { agent: ['broken', 'default'], chat: ['fixture/must-not-run'] }, defaults: ['working'] },
  agent: { promptBytes: 6000, timeoutSeconds: 2, embedding: { endpoint, model: 'fixture-vectors' } },
}))
process.env.STOKD_AGENT_CONFIG = config
process.env.STOKD_AGENT_HOME = path.join(dir, 'data')
process.env.STOKD_AGENT_BIN_DIR = path.join(dir, 'bin')
process.env.STOKD_AGENT_ENGINE = path.resolve('apps/agent-cli/target/debug/stokd-agent-engine')
const transport = new EngineTransport(path.resolve('.'))
let reopened: InstanceType<typeof EngineTransport> | undefined
try {
  const created = await transport.request<{ agent: { name: string }; shim: string }>('agent.create', { name: 'navigator', identity: 'Help plan journeys', remit: 'Maps and travel' })
  assert.equal((await transport.request<{ workload: string }>('model.list')).value!.workload, 'agent')
  assert.equal(created.value!.agent.name, 'navigator')
  assert.match(await fs.readFile(created.value!.shim, 'utf8'), /exec '.*' '.*' chat 'navigator' "\$@"/)
  await assert.rejects(transport.request('agent.create', { name: 'navigator' }), /shim already exists/)
  await fs.symlink(path.join(dir, 'missing'), path.join(process.env.STOKD_AGENT_BIN_DIR, 'collision'))
  await assert.rejects(transport.request('agent.create', { name: 'collision' }), /shim already exists/)
  await assert.rejects(transport.request('agent.get', { agent: 'collision' }), /Agent not found/)
  await assert.rejects(transport.request('route.cli', { args: ['create', 'bad', '--shell'] }), /Unsupported/)
  const opened = (await transport.request<Snapshot>('conversation.open', { agent: 'navigator' })).value!
  const params = { agent: 'navigator', conversationId: opened.conversation.id }
  await transport.request('turn.submit', { ...params, text: 'My compass is named Juniper.' })
  let snapshot: Snapshot
  await until(async () => { snapshot = (await transport.request<Snapshot>('conversation.snapshot', params)).value!; return snapshot.turn?.state === 'complete' }, 'first turn')
  assert.equal(snapshot!.messages.length, 2)
  assert.equal(snapshot!.approvals.length, 1)
  assert.equal(snapshot!.artifacts.length, 0)
  assert.equal(snapshot!.turn!.model, 'fixture/working')
  assert.deepEqual(calls.slice(0, 2).map(c => c.model), ['broken', 'working'])
  assert(calls.every(c => c.messages.length === 1 && Buffer.byteLength(c.messages[0].content) <= 6000))
  const memories = (await transport.request<Memory[]>('memory.list', { agent: 'navigator' })).value!
  assert.equal(memories.length, 1)
  const approvalId = snapshot!.approvals[0].id
  await transport.request('approval.resolve', { ...params, id: approvalId, allow: true })
  await assert.rejects(transport.request('approval.resolve', { ...params, id: approvalId, allow: true }), /not pending/)
  await transport.request('turn.submit', { ...params, text: 'WAIT' })
  await until(() => calls.some(c => c.messages[0].content.includes('Current user message:\nWAIT\n')), 'model started')
  const start = Date.now()
  await transport.request('turn.cancel', params)
  assert(Date.now() - start < 1000, 'cancel must not wait for provider timeout')
  const cancelled = (await transport.request<Snapshot>('conversation.snapshot', params)).value!
  assert.equal(cancelled.turn!.state, 'cancelled')
  assert.equal(cancelled.messages.length, 3)
  await transport.close()
  reopened = new EngineTransport(path.resolve('.'))
  const restored = (await reopened.request<Snapshot>('conversation.open', params)).value!
  assert.equal(restored.messages.length, 3)
  assert.equal(restored.artifacts.length, 1)
  assert.equal(restored.turn!.state, 'cancelled')
  const replay = (await reopened.request<{ events: Array<{ seq: number }> }>('conversation.replay', { ...params, after: 0 })).value!
  assert(replay.events.every((e, i) => e.seq === i + 1))
  await assert.rejects(reopened.request('route.slash', { ...params, line: '/reload' }), /Unsupported/)
  await assert.rejects(reopened.request('route.slash', { ...params, line: '!touch unsafe' }), /Unsupported/)

  // Projection checks include duplicate delivery, gaps and late old-conversation events.
  const projection = new AgentChannel(reopened, 'navigator')
  await projection.open(opened.conversation.id)
  const cursor = projection.cursor
  assert(projection.apply({ conversationId: 'old', seq: 1, kind: 'message.committed', data: {}, createdAt: 0 }))
  assert.equal(projection.cursor, cursor)
  assert(!projection.apply({ conversationId: projection.conversationId, seq: cursor + 2, kind: 'notice', data: {}, createdAt: 0 }))
  const event = { conversationId: projection.conversationId, seq: cursor + 1, kind: 'response.provisional', data: { turnId: 'provisional', content: 'Not yet committed' }, createdAt: 0 }
  assert(projection.apply(event)); assert(projection.apply(event)); assert.equal(projection.messages.length, 3)
  assert.equal(projection.provisional!.content, 'Not yet committed')
  assert(projection.apply({ ...event, seq: cursor + 2, kind: 'turn.interrupted' })); assert.equal(projection.provisional, null)
  projection.historical = true
  projection.messages = [restored.messages[0]]
  await projection.present({ method: 'turn.submit', value: { state: 'running' } })
  assert.equal(projection.historical, false)
  assert.deepEqual(projection.messages, restored.messages, 'submitting from history must restore the latest window')
  assert.equal(projection.cursor, restored.conversation.cursor)
  projection.dispose()

  await verifyRendering(restored, memories)
  process.stdout.write('Stokd: fallback, bounded HTTP inference, durable restart, approvals, cancel, shims, replay and donor TUI checks passed\n')
} finally {
  await transport.close()
  await reopened?.close()
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await fs.rm(dir, { recursive: true, force: true })
}

async function verifyRendering(snapshot: Snapshot, memories: Memory[]) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  const mock: Transport = {
    async request<T>(method: string, params: Record<string, unknown> = {}): Promise<RoutedResult<T>> {
      requests.push({ method, params })
      if (method === 'conversation.open') return { method, value: structuredClone(snapshot) as T }
      if (method === 'route.slash') {
        const line = String(params.line)
        if (line === '/memories') return { method: 'memory.list', value: memories as T }
        if (line === '/conversations') return { method: 'conversation.list', value: [snapshot.conversation] as T }
        if (line === '/identity') return { method: 'agent.get', value: snapshot.agent as T }
        if (line.startsWith('/correct')) return { method: 'memory.correct', value: {} as T }
        throw new Error('Unsupported command: ' + line)
      }
      if (method === 'memory.list') return { method, value: memories as T }
      if (method === 'conversation.replay') return { method, value: { events: [], hasMore: false } as T }
      if (method === 'conversation.snapshot') return { method, value: snapshot as T }
      throw new Error('Unexpected render request: ' + method)
    },
  }
  setLang('en')
  for (const fullscreen of [false, true]) {
    for (const cols of [100, 40]) {
      const rows = 24
      const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
      let raw = false
      const frames: string[] = []
      class Output extends Writable {
        columns = cols; rows = rows; isTTY = true
        _write(chunk: unknown, _encoding: BufferEncoding, cb: () => void) { frames.push(String(chunk)); term.write(String(chunk), cb) }
      }
      class Input extends PassThrough { isTTY = true; setRawMode(value: boolean) { raw = value; return this } ref() { return this } unref() { return this } }
      const stdout = new Output() as Output & NodeJS.WriteStream
      const stdin = new Input() as Input & NodeJS.ReadStream
      const screen = () => Array.from({ length: rows }, (_, i) => term.buffer.active.getLine(term.buffer.active.viewportY + i)?.translateToString(true) ?? '').join('\n')
      const channel = new AgentChannel(mock, 'navigator')
      await channel.open()
      const app = await render(React.createElement(AgentChat, { channel, fullscreen }), { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false })
      try {
        await until(() => screen().includes('navigator') && screen().includes('Juniper'), `chat at ${cols} columns`)
        assert(!/[\u3400-\u9fff]/u.test(screen()), 'Agent UI must be English')
        stdin.write('/memories')
        await until(() => screen().includes('/memories'), 'typing command')
        stdin.write('\r')
        await until(() => channel.panel === 'memories' && screen().includes('revision 1'), 'memory panel')
        stdin.write('e')
        await until(() => screen().includes('/correct'), 'correction uses the donor prompt editor')
        stdin.write('\x03')
        await sleep(100)
        const before = requests.length
        stdin.write('\x07')
        await until(() => screen().includes('External editor'), 'external editor is disabled')
        assert.equal(requests.length, before, 'editor must not dispatch a domain command')
        channel.run('/identity')
        await until(() => screen().includes('Maps and travel'), 'identity/remit panel')
        stdin.write('\x1b')
        await until(() => channel.panel === null, 'Escape closes panel')
        stdout.columns = 32
        term.resize(32, rows)
        stdout.emit('resize')
        await until(() => screen().includes('navigator'), 'narrow resize')
        const mode = term.buffer.active.type
        assert.equal(mode, fullscreen ? 'alternate' : 'normal')
      } catch (error) { process.stderr.write(JSON.stringify({ cols, fullscreen, panel: channel.panel, notice: channel.notice, screen: screen(), requests: requests.slice(-5) }, null, 2) + '\n'); throw error } finally { app.unmount(); app.cleanup(); channel.dispose(); stdin.destroy(); await sleep(50); assert.equal(raw, false); assert.equal(term.buffer.active.type, 'normal'); term.dispose() }
    }
  }
}

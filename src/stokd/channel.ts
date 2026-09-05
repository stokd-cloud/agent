import { completeCommands, type LocalCommand } from '../commands.js'
import type { PromptChannel } from '../components/PromptInput.js'
import type { Agent, Artifact, Conversation, DomainEvent, Memory, Message, RoutedResult, Snapshot, Transport } from './protocol.js'

export type Panel = 'conversations' | 'identity' | 'memories' | 'artifacts' | 'work' | 'approvals' | 'help' | 'models' | 'artifact' | null

const commands: LocalCommand[] = [
  ['conversations', 'List and select conversations'], ['new', 'Start a conversation'], ['select', 'Open a conversation by ID'],
  ['identity', 'Inspect or change this agent’s identity'], ['remit', 'Inspect or change this agent’s remit'],
  ['memories', 'Inspect, correct or forget memories'], ['correct', 'Correct a memory: id revision text'], ['forget', 'Forget a memory: id revision'],
  ['artifacts', 'Browse saved artifacts'], ['artifact', 'Read an artifact by ID'], ['work', 'View work items'], ['status', 'Inspect current work status'],
  ['steer', 'Redirect the running response'], ['cancel', 'Cancel current work'], ['approvals', 'Review pending actions'],
  ['approve', 'Approve an action by ID'], ['deny', 'Deny an action by ID'], ['models', 'Inspect the configured model chain'], ['help', 'Show help'], ['exit', 'Leave this agent'],
].map(([name, description]) => ({ name, description }))

/** A bounded projection of persisted facts. No optimistic messages or writes. */
export class AgentChannel {
  version = 0
  snapshot: Snapshot | null = null
  messages: Message[] = []
  cursor = 0
  provisional: { turnId: string; content: string } | null = null
  panel: Panel = null
  panelData: unknown = null
  notice = ''
  fatal = ''
  historical = false
  busy = false
  private generation = 0
  private listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  private polling = false
  private serial: Promise<void> = Promise.resolve()
  onExit: () => void = () => {}
  onFailure: (error: Error) => void = () => {}

  constructor(readonly transport: Transport, readonly agentName: string) {}

  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = (): number => this.version
  emit(): void { this.version++; for (const listener of this.listeners) listener() }
  get working(): boolean { return this.busy || this.snapshot?.turn?.state === 'running' }
  get conversationId(): string { return this.snapshot?.conversation.id ?? '' }

  async start(): Promise<void> {
    await this.open()
    this.schedule()
  }

  private schedule(): void {
    if (this.disposed) return
    this.timer = setTimeout(() => { void this.refresh().finally(() => this.schedule()) }, 400)
  }

  async open(id?: string): Promise<void> {
    const generation = ++this.generation
    const result = await this.transport.request<Snapshot>('conversation.open', { agent: this.agentName, ...(id ? { conversationId: id } : {}) })
    if (generation !== this.generation || this.disposed) return
    this.hydrate(result.value!)
    this.panel = null
    this.emit()
  }

  private hydrate(snapshot: Snapshot): void {
    this.snapshot = snapshot
    this.messages = snapshot.messages
    this.cursor = snapshot.conversation.cursor
    this.provisional = null
    this.historical = false
  }

  /** Returns false on a cursor gap; caller must resnapshot instead of guessing. */
  apply(event: DomainEvent): boolean {
    if (event.conversationId !== this.conversationId || event.seq <= this.cursor) return true
    if (event.seq !== this.cursor + 1) return false
    this.cursor = event.seq
    if (event.kind === 'message.committed') {
      const { role, content, turnId } = event.data
      if (typeof role !== 'string' || typeof content !== 'string' || typeof turnId !== 'string') return false
      if (!this.historical) this.messages = [...this.messages, { seq: event.seq, role, content, turnId }].slice(-120)
      if (role === 'assistant' && this.provisional?.turnId === turnId) this.provisional = null
    } else if (event.kind === 'response.provisional') {
      const { turnId, content } = event.data
      if (typeof turnId === 'string' && typeof content === 'string') this.provisional = { turnId, content }
    } else if (['turn.cancelled', 'turn.failed', 'turn.interrupted', 'turn.complete'].includes(event.kind)) {
      if (this.provisional?.turnId === event.data.turnId) this.provisional = null
    } else if (event.kind === 'notice' && typeof event.data.message === 'string') this.notice = event.data.message
    return true
  }

  async refresh(): Promise<void> {
    if (this.polling || !this.snapshot || this.disposed) return
    this.polling = true
    const generation = this.generation
    const params = { agent: this.agentName, conversationId: this.conversationId }
    try {
      let changed = false
      while (true) {
        const result = await this.transport.request<{ events: DomainEvent[]; hasMore: boolean }>('conversation.replay', { ...params, after: this.cursor })
        if (generation !== this.generation || this.disposed) return
        const events = result.value!.events
        changed ||= events.length > 0
        if (!events.every(event => this.apply(event))) {
          const snapshot = await this.transport.request<Snapshot>('conversation.snapshot', params)
          if (generation === this.generation) this.hydrate(snapshot.value!)
          break
        }
        if (!result.value!.hasMore) break
      }
      // Also refresh while running so an abandoned process is recovered by the
      // engine even when no new event has appeared yet.
      if (changed || this.working) {
        const result = await this.transport.request<Snapshot>('conversation.snapshot', params)
        if (generation !== this.generation || this.disposed) return
        // Keep the replay cursor: this snapshot may include a newer commit.
        this.snapshot = result.value!
        if (changed && this.panel === 'approvals') this.panelData = this.snapshot.approvals
        if (changed && this.panel === 'work') this.panelData = this.snapshot.work
        this.emit()
      }
    } catch (error) {
      if (generation !== this.generation || this.disposed) return
      this.fatal = error instanceof Error ? error.message : String(error)
      this.emit()
      this.onFailure(new Error(this.fatal))
    } finally { this.polling = false }
  }

  run(line: string): void {
    // Capture the conversation at the user's action; a late response cannot
    // repopulate the newly selected conversation or redirect a queued command.
    const conversationId = this.conversationId
    this.serial = this.serial.then(async () => {
      this.busy = true
      this.notice = ''
      this.emit()
      try {
        const result = await this.transport.request('route.slash', { agent: this.agentName, conversationId, line })
        if (this.disposed) return
        if (result.view === 'view.exit') { this.onExit(); return }
        if (this.conversationId !== conversationId) return
        await this.present(result)
        await this.refresh()
      } catch (error) { this.notice = error instanceof Error ? error.message : String(error) }
      finally { this.busy = false; this.emit() }
    })
  }

  async present(result: RoutedResult): Promise<void> {
    const generation = this.generation
    const { method, value } = result
    if (method === 'conversation.new' || method === 'conversation.open') { ++this.generation; this.hydrate(value as Snapshot); this.panel = null }
    else if (method === 'agent.get' || method === 'identity.set') { this.panel = 'identity'; this.panelData = value; if (this.snapshot) this.snapshot.agent = value as Agent }
    else if (method === 'conversation.list') { this.panel = 'conversations'; this.panelData = value as Conversation[] }
    else if (method === 'memory.list') { this.panel = 'memories'; this.panelData = value as Memory[] }
    else if (method === 'artifact.list') { this.panel = 'artifacts'; this.panelData = value as Artifact[] }
    else if (method === 'artifact.get') { this.panel = 'artifact'; this.panelData = value }
    else if (method === 'work.list' || method === 'work.status') { this.panel = 'work'; this.panelData = method === 'work.list' ? value : this.snapshot?.work }
    else if (method === 'approval.list') { this.panel = 'approvals'; this.panelData = value }
    else if (method === 'system.help') { this.panel = 'help'; this.panelData = (value as { text: string }).text }
    else if (method === 'model.list') { this.panel = 'models'; this.panelData = value }
    else if (method === 'memory.correct' || method === 'memory.forget') {
      const result = await this.transport.request<Memory[]>('memory.list', { agent: this.agentName })
      if (generation !== this.generation || this.disposed) return
      this.panel = 'memories'; this.panelData = result.value; this.notice = method === 'memory.forget' ? 'Memory forgotten' : 'Memory corrected'
    } else if (method === 'approval.resolve') { this.notice = `Action ${(value as { state: string }).state}` }
    else if (method === 'turn.submit' || method === 'turn.steer') {
      if (this.historical) {
        // Starting a turn from an older page restores the current window;
        // appending to that old page would silently omit intervening messages.
        const result = await this.transport.request<Snapshot>('conversation.snapshot', { agent: this.agentName, conversationId: this.conversationId })
        if (generation !== this.generation || this.disposed) return
        ++this.generation
        this.hydrate(result.value!)
      }
      this.panel = null
    }
    this.emit()
  }

  async older(): Promise<void> {
    const generation = this.generation
    const result = await this.transport.request<Message[]>('conversation.history', {
      agent: this.agentName, conversationId: this.conversationId, before: this.messages[0]?.seq, limit: 60,
    })
    if (generation !== this.generation || this.disposed) return
    if (result.value?.length) { this.messages = result.value; this.historical = true }
    else this.notice = 'Beginning of conversation'
    this.emit()
  }

  closePanel(): void { this.panel = null; this.emit() }
  dispose(): void { this.disposed = true; ++this.generation; clearTimeout(this.timer); this.listeners.clear() }

  /** The reused donor editor receives a restricted structural action surface. */
  get prompt(): PromptChannel {
    const host = this
    return {
      expandEditor: false, commandList: commands,
      commandCompletions: value => completeCommands(value, commands),
      listFileCandidates: async () => [],
      submit: value => { if (host.working) { host.notice = 'Use Enter to steer, or wait until the turn finishes'; host.emit(); return false } host.run(value); return true },
      steer: value => { host.run(value.startsWith('/') || value.startsWith('!') || value.startsWith('$') ? value : `/steer ${value}`) },
      notify: message => { host.notice = message; host.emit(); return () => {} },
      get working() { return host.working }, pending: [], removePending: () => false,
      interruptAndDeliver: values => { host.run(`/steer ${values.join('\n')}`); return values.length },
      stageImage: async () => { throw new Error('Image/file staging is unsupported') },
      cycleMode: async () => { host.notice = 'Native mode changes are unsupported'; host.emit() },
      sessionColor: '', mode: { id: 'agent', plan: false }, notifications: [],
      sessionTitle: this.snapshot?.conversation.title ?? '', promptSessionLabel: false,
      reasoningEffort: undefined, effortLevels: undefined,
    }
  }
}

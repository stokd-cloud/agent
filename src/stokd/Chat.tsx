import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import stripAnsi from 'strip-ansi'
import { AlternateScreen, Box, ScrollBox, Text, ThemeProvider, useInput, useTerminalSize, type ScrollBoxHandle } from '../ui.js'
import { PromptInput, type PromptController } from '../components/PromptInput.js'
import { UserPromptMessage } from '../components/messages/UserPromptMessage.js'
import { AssistantTextMessage } from '../components/messages/AssistantTextMessage.js'
import { Markdown } from '../components/Markdown.js'
import { AgentChannel } from './channel.js'
import type { Agent, Approval, Artifact, Conversation, Memory, Work } from './protocol.js'

const safe = (text: string): string => stripAnsi(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '')

function Body({ channel }: { channel: AgentChannel }): React.ReactNode {
  useSyncExternalStore(channel.subscribe, channel.getVersion)
  const { rows, columns } = useTerminalSize()
  const scroll = useRef<ScrollBoxHandle | null>(null)
  const controller = useRef<PromptController | null>(null)
  const prompt = useMemo(() => channel.prompt, [channel])
  const [fill, setFill] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const [forget, setForget] = useState<Memory | null>(null)
  const [confirmApproval, setConfirmApproval] = useState<Approval | null>(null)
  const snapshot = channel.snapshot
  const panel = channel.panel
  const items = Array.isArray(channel.panelData) ? channel.panelData as Array<Conversation | Memory | Artifact | Work | Approval> : []
  const index = Math.min(selected, Math.max(0, items.length - 1))
  const item = items[index]
  const visibleRows = Math.max(1, rows - 12)
  const windowStart = Math.max(0, index - Math.floor(visibleRows / 2))
  useEffect(() => { setSelected(0); setForget(null); setConfirmApproval(null); scroll.current?.scrollTo(0) }, [panel])
  useEffect(() => { if (!panel && !channel.historical) scroll.current?.scrollToBottom() }, [channel.conversationId, channel.messages.length, panel])
  useEffect(() => { if (channel.historical) scroll.current?.scrollTo(0) }, [channel.historical, channel.messages[0]?.seq])
  const edit = (line: string) => { channel.closePanel(); setFill(line) }
  const activate = () => {
    if (!item) return
    if (panel === 'conversations') channel.run(`/select ${item.id}`)
    if (panel === 'artifacts') channel.run(`/artifact ${item.id}`)
    if (panel === 'memories') { const memory = item as Memory; edit(`/correct ${memory.id} ${memory.revision} ${memory.content}`) }
    if (panel === 'approvals') setConfirmApproval(item as Approval)
  }
  useInput((input, key, event) => {
    if (forget || confirmApproval) {
      event.stopImmediatePropagation()
      if (key.escape || input === 'n') { setForget(null); setConfirmApproval(null) }
      else if (input === 'y') {
        if (forget) channel.run(`/forget ${forget.id} ${forget.revision}`)
        if (confirmApproval) channel.run(`/approve ${confirmApproval.id}`)
        setForget(null); setConfirmApproval(null)
      }
      return
    }
    if (key.ctrl && input === 'c') {
      event.stopImmediatePropagation()
      if (panel) channel.closePanel()
      else if (controller.current?.consumeSelectionCopy()) return
      else if (controller.current?.hasText()) controller.current.clear()
      else if (channel.working) channel.run('/cancel')
      else channel.onExit()
      return
    }
    if (key.ctrl && input === 'b') { event.stopImmediatePropagation(); channel.run('/conversations'); return }
    if (!panel && key.ctrl && input === 'p' && !controller.current?.hasText()) {
      event.stopImmediatePropagation()
      void channel.older().catch(error => { channel.notice = String(error); channel.emit() })
      return
    }
    if (!panel && key.ctrl && input === 'l') {
      event.stopImmediatePropagation()
      void channel.open(channel.conversationId).catch(error => { channel.notice = String(error); channel.emit() })
      return
    }
    if (key.pageUp || key.pageDown) { event.stopImmediatePropagation(); scroll.current?.scrollBy((key.pageUp ? -1 : 1) * Math.max(1, rows - 10)); return }
    if (panel) {
      event.stopImmediatePropagation()
      if (key.escape || input === 'q') channel.closePanel()
      else if (key.upArrow) setSelected(Math.max(0, index - 1))
      else if (key.downArrow) setSelected(Math.min(items.length - 1, index + 1))
      else if (key.return) activate()
      else if (input === 'n' && panel === 'conversations') edit('/new ')
      else if (input === 'e' && panel === 'memories') activate()
      else if (input === 'f' && panel === 'memories' && item) setForget(item as Memory)
      else if (input === 'd' && panel === 'approvals' && item) channel.run(`/deny ${item.id}`)
      else if (input === 'e' && panel === 'identity') edit(`/identity ${(channel.panelData as Agent).identity}`)
      else if (input === 'r' && panel === 'identity') edit(`/remit ${(channel.panelData as Agent).remit}`)
      return
    }
    if (key.escape && !controller.current?.hasText() && channel.working) { event.stopImmediatePropagation(); channel.run('/cancel') }
  })
  if (!snapshot) return <Text>Opening {safe(channel.agentName)}…</Text>
  const turn = snapshot.turn
  const topTabs = columns >= 80 ? ['conversations', 'identity', 'memories', 'artifacts', 'work', 'approvals'] : ['conversations', 'memories', 'approvals']
  const panelLabel = panel === 'identity' ? 'Identity & remit' : panel ? panel[0].toUpperCase() + panel.slice(1) : ''
  return <Box flexDirection="column" height={Math.max(6, rows - 1)} width="100%" paddingX={1}>
    <Box flexShrink={0} justifyContent="space-between">
      <Text bold color="suggestion">{safe(snapshot.agent.name)}</Text>
      <Text dimColor wrap="truncate-end">{channel.working ? turn?.stage ?? 'Sending' : 'Ready'}{turn?.model ? ` · ${turn.model}` : ''}</Text>
    </Box>
    <Text dimColor wrap="truncate-end">{safe(snapshot.conversation.title)} · {snapshot.conversation.id}</Text>
    <Box flexShrink={0} gap={2}>
      {topTabs.map(tab => <Box key={tab} onClick={() => channel.run(`/${tab}`)}><Text color={tab === panel ? 'suggestion' : 'subtle'} underline={tab === panel}>{tab === 'approvals' ? `${tab} (${snapshot.approvals.length})` : tab}</Text></Box>)}
    </Box>
    <ScrollBox ref={scroll} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} stickyScroll={!panel && !channel.historical}>
      {panel ? <Box flexDirection="column" paddingY={1}>
        <Text bold>{panelLabel}{items.length ? ` · ${items.length}` : ''}</Text>
        {['conversations', 'memories', 'artifacts', 'work', 'approvals'].includes(panel) && <>
          {items.length === 0 && <Text dimColor>{panel === 'memories' ? 'No memories yet. Durable facts will appear here after an exchange.' : panel === 'approvals' ? 'No actions are waiting for approval.' : panel === 'work' ? 'No work items yet. Ask the agent to propose a work item.' : panel === 'artifacts' ? 'No artifacts yet. Ask the agent to draft an artifact.' : 'No conversations yet.'}</Text>}
          {items.slice(windowStart, windowStart + visibleRows).map((row, offset) => <Box key={row.id} flexDirection="column" paddingY={panel === 'memories' ? 1 : 0} onClick={() => setSelected(windowStart + offset)}>
            <Text color={windowStart + offset === index ? 'suggestion' : undefined} bold={windowStart + offset === index} wrap="truncate-end">
              {windowStart + offset === index ? '❯ ' : '  '}{safe('title' in row ? row.title : 'content' in row ? row.content : row.action.title)}{'status' in row ? ` · ${row.status}` : ''}
            </Text>
            {windowStart + offset === index && <Text dimColor wrap="truncate-end">  {'revision' in row ? `revision ${row.revision} · ` : ''}{row.id}</Text>}
          </Box>)}
          {items.length > visibleRows && <Text dimColor>{index + 1} of {items.length} · ↑↓ to browse</Text>}
          {panel === 'memories' && item && <Box paddingTop={1}><Text>{safe((item as Memory).content)}</Text></Box>}
          {panel === 'approvals' && item && <Box flexDirection="column" paddingTop={1}><Text bold>{safe((item as Approval).action.kind)}</Text><Markdown children={safe((item as Approval).action.content ?? (item as Approval).action.title)} /></Box>}
        </>}
        {panel === 'identity' && <>
          <Text bold>Identity</Text><Text>{safe((channel.panelData as Agent).identity)}</Text>
          <Box paddingTop={1} flexDirection="column"><Text bold>Remit</Text><Text>{safe((channel.panelData as Agent).remit) || 'No remit set. Press R to describe this agent’s responsibilities.'}</Text></Box>
        </>}
        {panel === 'help' && <Text>{String(channel.panelData)}</Text>}
        {panel === 'models' && <Text>{JSON.stringify(channel.panelData, null, 2)}</Text>}
        {panel === 'artifact' && <Markdown children={safe((channel.panelData as Artifact).content ?? '')} />}
      </Box> : <>
        <Box gap={3} paddingTop={1}>
          <Box onClick={() => { void channel.older().catch(error => { channel.notice = String(error); channel.emit() }) }}><Text dimColor underline>Earlier messages</Text></Box>
          {channel.historical && <Box onClick={() => { void channel.open(channel.conversationId).catch(error => { channel.notice = String(error); channel.emit() }) }}><Text color="suggestion" underline>Return to latest</Text></Box>}
        </Box>
        {channel.messages.length === 0 && <Box paddingY={2} flexDirection="column"><Text>Start a conversation with {safe(snapshot.agent.name)}.</Text><Text dimColor>{safe(snapshot.agent.remit) || 'Your conversations and memories will be here when you return.'}</Text></Box>}
        {channel.messages.map(message => message.role === 'user'
          ? <UserPromptMessage key={message.seq} text={safe(message.content)} addMargin />
          : <AssistantTextMessage key={message.seq} text={safe(message.content)} addMargin />)}
        {channel.provisional && <Box paddingTop={1} flexDirection="column"><Text color="warning">Provisional response · awaiting commit</Text><Markdown children={safe(channel.provisional.content)} /></Box>}
        {channel.working && <Box paddingTop={1}><Text dimColor>{turn?.stage === 'learning' ? 'Saving memories…' : turn?.stage === 'compacting' ? 'Updating the rolling summary…' : 'Thinking…'}</Text></Box>}
        {turn?.error && <Text color="warning">{safe(turn.error)}</Text>}
      </>}
    </ScrollBox>
    {snapshot.approvals.length > 0 && panel !== 'approvals' && <Box flexShrink={0} onClick={() => channel.run('/approvals')}><Text color="warning">{snapshot.approvals.length} action{snapshot.approvals.length === 1 ? '' : 's'} waiting · /approvals to review</Text></Box>}
    {channel.notice && <Text color="warning" wrap="truncate-end">{safe(channel.notice)}</Text>}
    {forget || confirmApproval ? <Box flexDirection="column" borderStyle="round" borderColor="warning" flexShrink={0}>
      <Text bold>{forget ? 'Forget this memory?' : 'Approve this action?'}</Text>
      <Text wrap="truncate-end">{safe(forget?.content ?? confirmApproval?.action.title ?? '')}</Text>
      <Text>Y confirms · N or Escape goes back</Text>
    </Box> : panel ? <Box flexShrink={0} paddingTop={1}><Text dimColor>{panel === 'memories' ? 'E correct · F forget · ' : panel === 'approvals' ? 'Enter review · D deny · ' : panel === 'identity' ? 'E edit identity · R edit remit · ' : panel === 'conversations' ? 'Enter select · N new · ' : panel === 'artifacts' ? 'Enter read · ' : ''}Esc returns · PgUp/PgDn scroll</Text></Box>
      : <PromptInput channel={prompt} localEffects={false} helpOpen={false} onToggleHelp={() => channel.run('/help')} onRunCommand={(name, rawInput) => { channel.run(`/${name}${rawInput ? ` ${rawInput}` : ''}`); return true }} selectionActive={false} fillText={fill} onFillConsumed={() => setFill(null)} controllerRef={controller} />}
    <Text dimColor wrap="truncate-end">{turn?.promptBytes ? `${turn.promptBytes.toLocaleString()} prompt bytes · ` : ''}{snapshot.summary.throughSeq ? `Compacted through ${snapshot.summary.throughSeq} · ` : ''}{panel ? 'Persistent agent' : 'Enter send/steer · /help · Ctrl+B conversations'}</Text>
  </Box>
}

export function AgentChat({ channel, fullscreen = false }: { channel: AgentChannel; fullscreen?: boolean }): React.ReactNode {
  const body = <ThemeProvider theme="dark"><Body channel={channel} /></ThemeProvider>
  return fullscreen ? <AlternateScreen>{body}</AlternateScreen> : body
}

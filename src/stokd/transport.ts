import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { RoutedResult, Transport } from './protocol.js'

/** NDJSON transport only: no agent state, routing policy or persistence. */
export class EngineTransport implements Transport {
  private child: ChildProcessWithoutNullStreams
  private sequence = 0
  private pending = new Map<number, { resolve(value: RoutedResult): void; reject(error: Error): void }>()
  private buffer = ''
  private closed = false
  private diagnostic = ''
  private exited: Promise<void>

  constructor(root = fileURLToPath(new URL('../../../', import.meta.url))) {
    const binary = process.env.STOKD_AGENT_ENGINE ?? [
      join(root, 'bin', 'stokd-agent-engine'),
      join(root, 'apps/agent-cli/target/release/stokd-agent-engine'),
      join(root, 'apps/agent-cli/target/debug/stokd-agent-engine'),
    ].find(existsSync)
    if (!binary) throw new Error('Rust engine is missing. Run pnpm build:agent first.')
    this.child = spawn(binary, ['serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, STOKD_AGENT_LAUNCHER: join(root, 'bin/stokd-agent.js'), STOKD_AGENT_NODE: process.execPath },
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => { this.diagnostic = (this.diagnostic + chunk).slice(-2000) })
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      if (this.buffer.length > 70_000_000) { this.fail(new Error('Engine response exceeds the transport limit')); this.child.kill(); return }
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        try {
          const response: unknown = JSON.parse(line)
          if (typeof response !== 'object' || response === null || !('id' in response) || !('ok' in response)) throw new Error('Invalid engine response')
          const record = response as { id: number; ok: boolean; result: RoutedResult; error?: { message: string } }
          const pending = this.pending.get(record.id)
          if (!pending) continue
          this.pending.delete(record.id)
          if (record.ok) pending.resolve(record.result)
          else pending.reject(new Error(record.error?.message ?? 'Domain command failed'))
        } catch (error) { this.fail(error instanceof Error ? error : new Error('Invalid engine response')) }
      }
    })
    this.child.on('error', error => this.fail(error))
    this.child.stdin.on('error', error => this.fail(error))
    this.exited = new Promise(resolve => this.child.on('close', code => {
      this.fail(new Error(`Engine exited (${code ?? 'signal'})${this.diagnostic ? `: ${this.diagnostic.trim()}` : ''}`))
      resolve()
    }))
  }

  private fail(error: Error): void {
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<RoutedResult<T>> {
    if (this.closed) return Promise.reject(new Error('Engine is disconnected. Exit and relaunch the agent.'))
    const id = ++this.sequence
    return new Promise<RoutedResult<T>>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as RoutedResult<T>), reject })
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) { this.pending.delete(id); reject(error) }
      })
    })
  }

  async close(): Promise<void> {
    this.child.stdin.end()
    const term = setTimeout(() => this.child.kill('SIGTERM'), 2000)
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 4000)
    try { await this.exited } finally { clearTimeout(term); clearTimeout(kill) }
  }
}

// Model access via the local `claude` CLI in headless mode. No API key to
// configure, and swapping providers means replacing only this file.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The model CLI reads the working directory as project context. Run it from an
// empty scratch directory so the agent answers as itself and not as an
// assistant reporting on whatever repository happens to be nearby.
const NEUTRAL_CWD = mkdtempSync(join(tmpdir(), 'stokd-agent-'))

export function ask(prompt, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
      cwd: NEUTRAL_CWD,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=12288' },
    })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('model timed out')) }, timeoutMs)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`model exited ${code}: ${err.trim().slice(0, 300)}`))
      resolve(out.trim())
    })
  })
}

// Rough but stable. Exact tokenization would need the provider's tokenizer;
// what matters here is that the budget is enforced, not that it is exact.
export function tokens(text) { return Math.ceil((text ?? '').length / 4) }

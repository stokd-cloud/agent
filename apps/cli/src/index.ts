
import { unsupportedError } from '@stokd-cloud/agent-protocol'

export interface CliIo { readonly stdout: { write(value: string): unknown }; readonly stderr: { write(value: string): unknown } }
export async function runCli(argv: readonly string[], io: CliIo = process): Promise<7> {
  const operation = argv.length > 0 ? argv.join(' ') : '<missing command>'
  const error = unsupportedError(`stokd-agent operation is not implemented: ${operation}`)
  io.stderr.write(`${JSON.stringify({ schemaVersion: '1.0', ok: false, error })}\n`)
  return 7
}

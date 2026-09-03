import { createHash } from 'node:crypto'
import { chmodSync, closeSync, openSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const [output] = process.argv.slice(2)
const operationId = 'valop_work12_durable_fixture'
const rawDirectory = realpathSync('/run/stokd-agent/raw')
if (!output || resolve(output) !== output || realpathSync(dirname(output)) !== rawDirectory || basename(output) !== 'validation-payload.secret') {
  throw new Error('validation payload path is not the exact guarded path')
}
const payload = createHash('sha256').update('stokd-agent/cloud-agents-mvp/fixed-validation-fixture/v1').digest()
const descriptor = openSync(output, 'wx', 0o400)
try { writeFileSync(descriptor, payload) } finally { closeSync(descriptor) }
chmodSync(output, 0o400)
process.stdout.write(`${operationId}\t${createHash('sha256').update(payload).digest('hex')}\n`)

import { chmodSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const [mode, output, ...args] = process.argv.slice(2)
const guardedDirectory = realpathSync('/run/stokd-agent')
if (!output || resolve(output) !== output || realpathSync(dirname(output)) !== guardedDirectory || !/^[a-z0-9][a-z0-9-]*\.json$/.test(basename(output))) {
  throw new Error('output must be one canonical file in the guarded runtime directory')
}
if (mode === 'canonical') {
  if (args.length) throw new Error('canonical mode accepts no extra arguments')
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  writeFileSync(output, JSON.stringify(parsed), { mode: 0o400, flag: 'wx' })
} else if (mode === 'credentials') {
  if (!args.length || args.length % 2) throw new Error('credentials mode requires key/path pairs')
  const value = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const path = args[index + 1]
    if (!/^(runtimePassword|migrationPassword|backupPassword|maintenanceSessionToken|sourceRuntimePassword|sourceMigrationPassword|sourceBackupPassword|priorRuntimePassword|priorMigrationPassword|priorBackupPassword)$/.test(key)) throw new Error('credential key is not allowlisted')
    const rawDirectory = realpathSync('/run/stokd-agent/raw')
    if (resolve(path) !== path || realpathSync(dirname(path)) !== rawDirectory || !/^[a-z0-9][a-z0-9-]*\.secret$/.test(basename(path))) throw new Error('credential input path is outside the guarded raw directory')
    const bytes = readFileSync(path)
    const payload = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a ? bytes.subarray(0, bytes.length - 1) : bytes
    const secret = payload.toString('utf8')
    if (secret.length < 32) throw new Error('credential is too short')
    value[key] = secret
  }
  writeFileSync(output, JSON.stringify(value), { mode: 0o400, flag: 'wx' })
} else throw new Error('unsupported JSON materialization mode')
chmodSync(output, 0o400)

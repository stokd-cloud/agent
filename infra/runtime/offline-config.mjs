import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const [basePath, outputPath, portRaw, pidRaw, startIdentity, dbPathIdentity] = process.argv.slice(2)
const guardedDirectory = realpathSync('/run/stokd-agent')
for (const path of [basePath, outputPath]) {
  if (!path || resolve(path) !== path || realpathSync(dirname(path)) !== guardedDirectory || !/^[a-z0-9][a-z0-9-]*\.json$/.test(basename(path))) throw new Error('offline config paths must be canonical guarded runtime paths')
}
const port = Number(portRaw)
const ownedProcessId = Number(pidRaw)
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 27017) throw new Error('offline port is invalid')
if (!Number.isInteger(ownedProcessId) || ownedProcessId < 2) throw new Error('offline process ID is invalid')
if (!/^\d+$/.test(startIdentity ?? '')) throw new Error('offline ownership identity is invalid')
if (!/^vol-[a-f0-9]{17}$/.test(dbPathIdentity ?? '')) throw new Error('offline dbpath identity is invalid')
const base = JSON.parse(readFileSync(basePath, 'utf8'))
if (base.schemaVersion !== '1.0' || base.command !== 'restore-offline' || !base.target?.resourceIds) throw new Error('offline base config is invalid')
const config = {
  ...base,
  noAuthUri: `mongodb://127.0.0.1:${port}/?directConnection=true`,
  maintenanceProof: {
    serviceWasStopped: true,
    authDisabled: true,
    loopbackOnly: true,
    ownedProcessId,
    processStartIdentity: startIdentity,
    dbPathIdentity,
    resourceIds: base.target.resourceIds,
  },
}
writeFileSync(outputPath, JSON.stringify(config), { mode: 0o400, flag: 'wx' })

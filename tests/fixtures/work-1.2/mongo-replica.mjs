import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const storageRequire = createRequire(new URL('../../../packages/storage/package.json', import.meta.url))
const { MongoClient } = storageRequire('mongodb')

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function executable(name, override) {
  const candidates = override ? [override] : (process.env.PATH ?? '').split(delimiter).map(path => join(path, name))
  for (const candidate of candidates) if (candidate && existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate)
  throw new Error(`${name} executable is missing`)
}

function requireVersion(path, expected) {
  const result = spawnSync(path, ['--version'], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout.includes(expected)) throw new Error(`${path} does not report ${expected}`)
}

async function randomLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForConnection(uri, predicate = async () => true, timeoutMS = 20_000) {
  const deadline = Date.now() + timeoutMS
  let lastError
  while (Date.now() < deadline) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 500, connectTimeoutMS: 500 })
    try {
      await client.connect()
      if (await predicate(client)) return client
    } catch (error) { lastError = error }
    await client.close().catch(() => undefined)
    await sleep(100)
  }
  throw new Error(`MongoDB readiness timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

function processStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 2) throw new Error('owned process PID is invalid')
  const procStat = `/proc/${pid}/stat`
  if (existsSync(procStat)) {
    const text = readFileSync(procStat, 'utf8')
    const close = text.lastIndexOf(')')
    const fields = text.slice(close + 2).trim().split(/\s+/)
    const startTicks = fields[19]
    if (!startTicks) throw new Error(`cannot read Linux process start time for PID ${pid}`)
    return `linux:${pid}:${startTicks}`
  }
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`cannot read process start identity for PID ${pid}`)
  return `posix:${pid}:${result.stdout.trim()}`
}

async function stopOwnedProcess(child, expectedStartIdentity) {
  if (!child || child.exitCode !== null) return
  if (processStartIdentity(child.pid) !== expectedStartIdentity) throw new Error(`refusing to signal reused or unowned PID ${child.pid}`)
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    sleep(10_000).then(() => false),
  ])
  if (!stopped) {
    if (processStartIdentity(child.pid) !== expectedStartIdentity) throw new Error(`refusing SIGKILL of reused or unowned PID ${child.pid}`)
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
  }
}

export function captureProtectedMongoListener(port = 27017) {
  const candidates = ['/usr/sbin/lsof', '/usr/bin/lsof']
  const lsofPath = candidates.find(candidate => existsSync(candidate)) ?? executable('lsof')
  const result = spawnSync(lsofPath, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpctn'], { encoding: 'utf8' })
  if (![0, 1].includes(result.status ?? -1)) throw new Error(`could not inspect protected MongoDB listener on port ${port}`)
  const lines = result.stdout.split('\n').filter(Boolean)
  const pids = lines.filter(line => line.startsWith('p')).map(line => Number(line.slice(1))).filter(Number.isInteger)
  return {
    port,
    listenerRecords: lines,
    processes: pids.map(pid => ({ pid, startIdentity: processStartIdentity(pid) })),
  }
}

export async function startAuthenticatedReplica(options) {
  const environment = options.environment
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(environment) || environment.includes('stokd')) throw new Error('invalid test environment')
  const databaseName = `agent_${environment.replaceAll('-', '_')}`
  const mongodPath = executable('mongod', process.env.AGENT_MONGOD_PATH)
  requireVersion(mongodPath, 'db version v7.0.29')
  const port = await randomLoopbackPort()
  if (port === 27017) throw new Error('random fixture selected protected port 27017')
  const replicaSet = `agent_${randomBytes(6).toString('hex')}`
  const root = mkdtempSync(join(options.temporaryParent ?? tmpdir(), 'stokd-agent-mongo-'))
  const dbPath = join(root, 'db')
  const logPath = join(root, 'mongod.log')
  const keyFile = join(root, 'replica.key')
  writeFileSync(keyFile, `${randomBytes(96).toString('base64')}\n`, { mode: 0o600 })
  chmodSync(keyFile, 0o600)
  mkdirSync(dbPath)
  let child
  let currentMode = 'stopped'
  let currentPort = null
  let currentProcessStartIdentity = null
  let maintenanceActive = false
  const children = []
  const start = ({ auth, standalone = false, listenPort = port }) => {
    const log = openSync(logPath, 'a', 0o600)
    const args = ['--port', String(listenPort), '--dbpath', dbPath, '--bind_ip', '127.0.0.1', '--nounixsocket']
    if (!standalone) args.push('--replSet', replicaSet)
    if (auth) args.push('--auth', '--keyFile', keyFile)
    child = spawn(mongodPath, args, { stdio: ['ignore', log, log] })
    child.once('exit', () => closeSync(log))
    if (!child.pid) throw new Error('fixture did not start an owned mongod')
    currentMode = standalone ? 'standalone-noauth' : auth ? 'replica-auth' : 'replica-noauth'
    currentPort = listenPort
    currentProcessStartIdentity = processStartIdentity(child.pid)
    children.push({ child, startIdentity: currentProcessStartIdentity })
    return child
  }

  const stopCurrent = async () => {
    const owned = child
    await stopOwnedProcess(owned, currentProcessStartIdentity)
    if (child === owned) {
      currentMode = 'stopped'
      currentPort = null
      currentProcessStartIdentity = null
    }
  }

  const username = suffix => `agent_${suffix}_${randomBytes(5).toString('hex')}`
  const password = () => randomBytes(24).toString('base64url')
  const provided = options.principalCredentials ?? {}
  const credential = kind => provided[kind] ?? { username: `agent_${kind}`, password: password() }
  const credentials = {
    runtime: credential('runtime'),
    migration: credential('migration'),
    backup: credential('backup'),
  }
  const address = `127.0.0.1:${port}`
  const unauthenticatedUri = `mongodb://${address}/?directConnection=true`
  try {
    start({ auth: false })
    let bootstrap = await waitForConnection(unauthenticatedUri)
    await bootstrap.db('admin').command({ replSetInitiate: { _id: replicaSet, members: [{ _id: 0, host: address }] } })
    await bootstrap.close()
    bootstrap = await waitForConnection(unauthenticatedUri, async client => (await client.db('admin').command({ hello: 1 })).isWritablePrimary === true)
    const admin = bootstrap.db('admin')
    const migrationRole = `agentMigration_${randomBytes(5).toString('hex')}`
    await admin.command({
      createRole: migrationRole,
      privileges: [{ resource: { cluster: true }, actions: ['getParameter'] }],
      roles: [{ role: 'readWrite', db: databaseName }, { role: 'dbAdmin', db: databaseName }],
    })
    await bootstrap.db(databaseName).command({ createUser: credentials.runtime.username, pwd: credentials.runtime.password, roles: [{ role: 'readWrite', db: databaseName }] })
    await admin.command({ createUser: credentials.migration.username, pwd: credentials.migration.password, roles: [{ role: migrationRole, db: 'admin' }] })
    await admin.command({ createUser: credentials.backup.username, pwd: credentials.backup.password, roles: [{ role: 'backup', db: 'admin' }, { role: 'clusterMonitor', db: 'admin' }] })
    await bootstrap.close()
    await stopCurrent()
    start({ auth: true })

    const encode = encodeURIComponent
    const runtimeUri = `mongodb://${encode(credentials.runtime.username)}:${encode(credentials.runtime.password)}@${address}/${databaseName}?authSource=${databaseName}&replicaSet=${replicaSet}`
    const migrationUri = `mongodb://${encode(credentials.migration.username)}:${encode(credentials.migration.password)}@${address}/${databaseName}?authSource=admin&replicaSet=${replicaSet}`
    const backupUri = `mongodb://${encode(credentials.backup.username)}:${encode(credentials.backup.password)}@${address}/?authSource=admin&replicaSet=${replicaSet}`
    const runtimeClient = await waitForConnection(runtimeUri, async client => (await client.db('admin').command({ hello: 1 })).isWritablePrimary === true)
    await runtimeClient.close()
    const migrationClient = await waitForConnection(migrationUri)
    await migrationClient.close()
    const dbPathIdentity = `${realpathSync(dbPath)}:${statSync(dbPath).dev}:${statSync(dbPath).ino}`
    const resourceSuffix = randomBytes(8).toString('hex')
    const resourceIds = Object.freeze({
      artifactBucket: `fixture-artifacts-${resourceSuffix}`,
      backupBucket: `fixture-backups-${resourceSuffix}`,
      databaseVolumeId: realpathSync(dbPath),
      kmsKeyArn: `fixture-kms-${resourceSuffix}`,
      mongoInstanceId: `fixture-mongo-${resourceSuffix}`,
    })
    const normalBaseUri = `mongodb://${address}/?replicaSet=${encodeURIComponent(replicaSet)}`
    const maintenanceController = {
      async enter(target) {
        if (maintenanceActive) throw new Error('maintenance session is already active')
        if (
          target.environment !== environment || target.databaseName !== databaseName || target.replicaSet !== replicaSet ||
          target.memberEndpoint !== address || JSON.stringify(target.resourceIds) !== JSON.stringify(resourceIds)
        ) throw new Error('maintenance controller target does not match the owned fixture')
        if (currentMode !== 'replica-auth' || currentPort !== port || !child || child.exitCode !== null) throw new Error('authenticated replica is not the owned active service')
        maintenanceActive = true
        await stopCurrent()
        const noAuthPort = await randomLoopbackPort()
        if (noAuthPort === 27017 || noAuthPort === port) throw new Error('maintenance fixture selected a protected or normal service port')
        start({ auth: false, standalone: true, listenPort: noAuthPort })
        const noAuthUri = `mongodb://127.0.0.1:${noAuthPort}/?directConnection=true`
        const noAuth = await waitForConnection(noAuthUri, async client => {
          const hello = await client.db('admin').command({ hello: 1 })
          return hello.isWritablePrimary === true && hello.setName === undefined
        })
        await noAuth.close()
        const ownedProcess = child
        const processStartIdentity = currentProcessStartIdentity
        const sessionToken = randomBytes(32).toString('base64url')
        let state = 'noauth'
        const enableAuth = async () => {
          if (state === 'auth') return { normalBaseUri }
          if (state !== 'noauth' || child !== ownedProcess || currentMode !== 'standalone-noauth') throw new Error('maintenance session lost ownership of its no-auth process')
          await stopCurrent()
          start({ auth: true })
          const normal = await waitForConnection(`mongodb://${address}/?directConnection=true`, async client => {
            const hello = await client.db('admin').command({ hello: 1 })
            return hello.isWritablePrimary === true && hello.setName === replicaSet && hello.me === address
          })
          await normal.close()
          state = 'auth'
          maintenanceActive = false
          return { normalBaseUri }
        }
        return {
          noAuthUri,
          proof: {
            serviceWasStopped: true,
            authDisabled: true,
            loopbackOnly: true,
            ownedProcessId: ownedProcess.pid,
            processStartIdentity,
            sessionToken,
            dbPathIdentity,
            resourceIds,
          },
          enableAuth,
          async close() {
            try {
              if (state === 'noauth') await enableAuth()
            } finally {
              maintenanceActive = false
            }
          },
        }
      },
    }
    return {
      root,
      port,
      address,
      replicaSet,
      databaseName,
      mongodPath,
      logPath,
      runtimeUri,
      migrationUri,
      backupUri,
      credentials,
      migrationRole,
      dbPath,
      dbPathIdentity,
      resourceIds,
      normalBaseUri,
      maintenanceController,
      targetIdentity: { environment, databaseName, replicaSet, memberEndpoint: address, resourceIds },
      get pid() { return child?.pid ?? null },
      async stop() {
        for (const process of children.toReversed()) await stopOwnedProcess(process.child, process.startIdentity)
        currentMode = 'stopped'
        maintenanceActive = false
        if (options.keepFiles !== true) rmSync(root, { recursive: true, force: true })
      },
      readLog() { return readFileSync(logPath, 'utf8') },
    }
  } catch (error) {
    for (const process of children.toReversed()) await stopOwnedProcess(process.child, process.startIdentity).catch(() => undefined)
    if (options.keepFiles !== true) rmSync(root, { recursive: true, force: true })
    throw error
  }
}

export function resolveMongoTools() {
  const mongodumpPath = executable('mongodump', process.env.AGENT_MONGODUMP_PATH)
  const mongorestorePath = executable('mongorestore', process.env.AGENT_MONGORESTORE_PATH)
  requireVersion(mongodumpPath, 'mongodump version: 100.14.0')
  requireVersion(mongorestorePath, 'mongorestore version: 100.14.0')
  return { mongodumpPath, mongorestorePath }
}

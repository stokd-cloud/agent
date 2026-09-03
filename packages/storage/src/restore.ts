import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { MongoClient, type Db } from 'mongodb'
import { assertAgentResourceIds, assertAgentSecretVersionIds, assertDatabaseToolVersion, internalMongoTool, MONGODB_DATABASE_TOOLS_VERSION, type AgentBackupManifest } from './backup.js'
import { agentDatabaseName, MONGODB_FCV, MONGODB_SERVER_VERSION } from './config.js'
import { AgentStorageError } from './errors.js'
import { assertSchemaCompatibility, verifyStorageCatalog } from './migration.js'
import type { ObjectCustodyRecord, ObjectRestoreTransport } from './object-custody.js'
import { readServerTime } from './readiness.js'
import { enterRestoredObservationMode, MongoDispatchBoundaryObserver, type RestoreReconciliationReport } from './recovery.js'

export interface RestorePrincipalRotation {
  readonly username: string
  readonly authDatabase: string
  readonly newPassword: string
  readonly secretVersionId: string
  readonly roles: readonly { readonly role: string; readonly db: string }[]
  readonly kind: 'runtime' | 'migration' | 'backup'
  readonly roleDefinition?: {
    readonly role: string
    readonly privileges: readonly { readonly resource: Readonly<Record<string, unknown>>; readonly actions: readonly string[] }[]
    readonly roles: readonly { readonly role: string; readonly db: string }[]
  }
}

export interface RestoreCredentialRotationReceipt {
  readonly rotatedAt: string
  readonly principals: readonly { readonly username: string; readonly authDatabase: string; readonly kind: RestorePrincipalRotation['kind']; readonly secretVersionId: string }[]
  readonly retiredArchivedPrincipals: readonly { readonly username: string; readonly authDatabase: string }[]
  readonly retiredArchivedRoles: readonly { readonly role: string; readonly database: string }[]
  readonly archivedCredentialProbeResults: readonly { readonly origin: ArchivedCredentialProbe['origin']; readonly kind: RestorePrincipalRotation['kind']; readonly rejected: true }[]
  readonly steadyStatePrincipalsOnly: true
}

export interface ArchivedCredentialProbe {
  readonly origin: 'source_archive' | 'target_pre_restore'
  readonly kind: RestorePrincipalRotation['kind']
  readonly uri: string
}

export interface RestoreTargetIdentity {
  readonly environment: string
  readonly databaseName: string
  readonly replicaSet: string
  readonly memberEndpoint: string
  readonly resourceIds: Readonly<Record<string, string>>
}

export interface IsolatedRestoreMaintenanceProof {
  readonly serviceWasStopped: true
  readonly authDisabled: true
  readonly loopbackOnly: true
  readonly ownedProcessId: number
  readonly processStartIdentity: string
  readonly sessionToken: string
  readonly dbPathIdentity: string
  readonly resourceIds: Readonly<Record<string, string>>
}

export interface IsolatedRestoreMaintenanceSession {
  readonly noAuthUri: string
  readonly proof: IsolatedRestoreMaintenanceProof
  enableAuth(): Promise<{ readonly normalBaseUri: string }>
  close(): Promise<void>
}

export interface IsolatedRestoreMaintenanceController {
  enter(target: RestoreTargetIdentity): Promise<IsolatedRestoreMaintenanceSession>
}

export interface OfflineRestoreReceiptPayload {
  readonly schemaVersion: '1.0'
  readonly receiptId: string
  readonly backupId: string
  readonly sourceEnvironment: string
  readonly sourceDatabase: string
  readonly target: RestoreTargetIdentity
  readonly manifestSha256: string
  readonly archiveSha256: string
  readonly objectManifestSha256: string
  readonly principalCatalogSha256: string
  readonly maintenanceProof: {
    readonly ownedProcessId: number
    readonly processStartIdentity: string
    readonly dbPathIdentitySha256: string
    readonly resourceIds: Readonly<Record<string, string>>
  }
  readonly retiredArchivedPrincipals: readonly { readonly username: string; readonly authDatabase: string }[]
  readonly retiredArchivedRoles: readonly { readonly role: string; readonly database: string }[]
  readonly offlineCompletedAt: string
}

export interface OfflineRestoreReceipt extends OfflineRestoreReceiptPayload {
  readonly integrityHmacSha256: string
}

export const RESTORE_PRINCIPAL_KINDS = ['runtime', 'migration', 'backup'] as const

type RoleAssignment = RestorePrincipalRotation['roles'][number]

function roleKey(role: RoleAssignment): string { return `${role.db}\0${role.role}` }

function exactRecord(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`
  return JSON.stringify(value)
}

function principalCatalogSha256(principals: readonly RestorePrincipalRotation[]): string {
  return createHash('sha256').update(stableJson(principals.map(({ newPassword: _secret, ...principal }) => principal))).digest('hex')
}

function signOfflineReceipt(payload: OfflineRestoreReceiptPayload, signingKey: Uint8Array): OfflineRestoreReceipt {
  if (signingKey.byteLength < 32) throw new AgentStorageError('restore_failed', 'offline receipt HMAC key must contain at least 32 bytes')
  return { ...payload, integrityHmacSha256: createHmac('sha256', signingKey).update(stableJson(payload)).digest('hex') }
}

function verifyOfflineReceipt(receipt: OfflineRestoreReceipt, signingKey: Uint8Array): OfflineRestoreReceiptPayload {
  const { integrityHmacSha256, ...payload } = receipt
  const expected = signOfflineReceipt(payload, signingKey).integrityHmacSha256
  const actualBytes = Buffer.from(integrityHmacSha256, 'hex')
  const expectedBytes = Buffer.from(expected, 'hex')
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) throw new AgentStorageError('restore_failed', 'offline restore receipt integrity check failed')
  return payload
}

function assertExactRoles(actual: readonly RoleAssignment[], expected: readonly RoleAssignment[], kind: RestorePrincipalRotation['kind']): void {
  const actualKeys = actual.map(roleKey).sort()
  const expectedKeys = expected.map(roleKey).sort()
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((value, index) => value !== expectedKeys[index])) {
    throw new AgentStorageError('restore_failed', `${kind} principal roles do not match the frozen steady-state role shape`, { actual: actualKeys, expected: expectedKeys })
  }
}

function assertPrincipalRotations(principals: readonly RestorePrincipalRotation[], targetDatabase: string): ReadonlyMap<RestorePrincipalRotation['kind'], RestorePrincipalRotation> {
  if (principals.length !== RESTORE_PRINCIPAL_KINDS.length) throw new AgentStorageError('restore_failed', 'restore requires exactly runtime, migration and backup rotations')
  const byKind = new Map<RestorePrincipalRotation['kind'], RestorePrincipalRotation>()
  const identities = new Set<string>()
  const passwords = new Set<string>()
  for (const principal of principals) {
    if (byKind.has(principal.kind)) throw new AgentStorageError('restore_failed', `duplicate ${principal.kind} principal rotation`)
    if (!/^agent_[a-z0-9_]{2,48}$/.test(principal.username) || principal.newPassword.length < 20 || !/^[A-Za-z0-9._-]{1,256}$/.test(principal.secretVersionId)) throw new AgentStorageError('restore_failed', `invalid ${principal.kind} principal rotation identity, secret or secret VersionId`)
    const identity = `${principal.authDatabase}\0${principal.username}`
    if (identities.has(identity) || passwords.has(principal.newPassword)) throw new AgentStorageError('restore_failed', 'principal identities and rotated secrets must be distinct')
    identities.add(identity)
    passwords.add(principal.newPassword)
    byKind.set(principal.kind, principal)
  }
  for (const kind of RESTORE_PRINCIPAL_KINDS) if (!byKind.has(kind)) throw new AgentStorageError('restore_failed', `missing ${kind} principal rotation`)

  const runtime = byKind.get('runtime')!
  if (runtime.username !== 'agent_runtime') throw new AgentStorageError('restore_failed', 'runtime principal name must be agent_runtime')
  if (runtime.authDatabase !== targetDatabase || runtime.roleDefinition) throw new AgentStorageError('restore_failed', 'runtime principal must be database-scoped without a custom role definition')
  assertExactRoles(runtime.roles, [{ role: 'readWrite', db: targetDatabase }], 'runtime')

  const migration = byKind.get('migration')!
  if (migration.username !== 'agent_migration') throw new AgentStorageError('restore_failed', 'migration principal name must be agent_migration')
  const definition = migration.roleDefinition
  if (migration.authDatabase !== 'admin' || !definition || migration.roles.length !== 1 || migration.roles[0]?.role !== definition.role || migration.roles[0]?.db !== 'admin') {
    throw new AgentStorageError('restore_failed', 'migration principal must use one declared admin custom role')
  }
  if (!/^agentMigration_[A-Za-z0-9_]{2,48}$/.test(definition.role)) throw new AgentStorageError('restore_failed', 'migration role name is invalid')
  if (
    definition.privileges.length !== 1 || JSON.stringify(definition.privileges[0]?.resource) !== JSON.stringify({ cluster: true }) ||
    definition.privileges[0]?.actions.length !== 1 || definition.privileges[0]?.actions[0] !== 'getParameter'
  ) {
    throw new AgentStorageError('restore_failed', 'migration role must grant only the pinned getParameter cluster action')
  }
  assertExactRoles(definition.roles, [{ role: 'readWrite', db: targetDatabase }, { role: 'dbAdmin', db: targetDatabase }], 'migration')

  const backup = byKind.get('backup')!
  if (backup.username !== 'agent_backup') throw new AgentStorageError('restore_failed', 'backup principal name must be agent_backup')
  if (backup.authDatabase !== 'admin' || backup.roleDefinition) throw new AgentStorageError('restore_failed', 'backup principal must use frozen admin roles')
  assertExactRoles(backup.roles, [{ role: 'backup', db: 'admin' }, { role: 'clusterMonitor', db: 'admin' }], 'backup')
  return byKind
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
function jsonSha256(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

function parseMongoAuthority(uri: string, requireAuthentication: boolean = true): { readonly parsed: URL; readonly targets: readonly { readonly host: string; readonly port: number }[] } {
  let parsed: URL
  try { parsed = new URL(uri) } catch { throw new AgentStorageError('restore_failed', 'restore URI is invalid') }
  if (parsed.protocol !== 'mongodb:') throw new AgentStorageError('restore_failed', 'restore URI must use mongodb')
  if (requireAuthentication && (!parsed.username || !parsed.password)) throw new AgentStorageError('restore_failed', 'restore URI must be authenticated MongoDB')
  if (!requireAuthentication && (parsed.username || parsed.password)) throw new AgentStorageError('restore_failed', 'no-auth maintenance URI must not contain credentials')
  const authority = uri.slice('mongodb://'.length).split('/', 1)[0] ?? ''
  const hosts = authority.slice(authority.lastIndexOf('@') + 1).split(',')
  const targets = hosts.map(value => {
    const match = /^\[([^\]]+)](?::(\d+))?$|^([^:]+)(?::(\d+))?$/.exec(value)
    if (!match) throw new AgentStorageError('restore_failed', `invalid MongoDB target ${value}`)
    const host = (match[1] ?? match[3] ?? '').toLowerCase()
    const port = Number(match[2] ?? match[4] ?? '27017')
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AgentStorageError('restore_failed', `invalid MongoDB port ${port}`)
    return { host, port }
  })
  return { parsed, targets }
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

function isCanonicalProcessStartIdentity(value: string, pid: number): boolean {
  const linux = /^linux:([1-9][0-9]*):([1-9][0-9]*)$/.exec(value)
  if (linux) return Number(linux[1]) === pid
  const posix = /^posix:([1-9][0-9]*):[A-Z][a-z]{2} [A-Z][a-z]{2} {1,2}[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4} .+$/.exec(value)
  return Boolean(posix && Number(posix[1]) === pid && !value.includes('\n') && !value.includes('\r'))
}

function assertTargetEnvironment(identity: RestoreTargetIdentity, sourceEnvironment: string): void {
  if (identity.environment === sourceEnvironment || !/^(?:restore|test|ci)-[a-z0-9-]{1,28}$/.test(identity.environment)) {
    throw new AgentStorageError('restore_failed', 'restore target must be a named isolated restore/test/ci environment')
  }
  if (identity.databaseName !== agentDatabaseName(identity.environment)) throw new AgentStorageError('restore_failed', 'target database does not match target environment')
  assertAgentResourceIds(identity.resourceIds, 'restore target resource IDs', 'restore_failed')
}

function assertIsolatedTarget(uri: string, identity: RestoreTargetIdentity, sourceEnvironment: string): URL {
  assertTargetEnvironment(identity, sourceEnvironment)
  const { parsed, targets } = parseMongoAuthority(uri)
  if (parsed.searchParams.get('replicaSet') !== identity.replicaSet) throw new AgentStorageError('restore_failed', 'restore URI replica set does not match target identity')
  if (targets.some(target => isLoopback(target.host) && target.port === 27017)) throw new AgentStorageError('restore_failed', 'restore may not target any default-port loopback MongoDB service')
  if (targets.length !== 1 || `${targets[0]!.host}:${targets[0]!.port}` !== identity.memberEndpoint.toLowerCase()) throw new AgentStorageError('restore_failed', 'restore URI must contain only the declared single target member endpoint')
  return parsed
}

function assertNoAuthMaintenanceTarget(noAuthUri: string, proof: IsolatedRestoreMaintenanceProof, identity: RestoreTargetIdentity, sourceEnvironment: string): void {
  assertTargetEnvironment(identity, sourceEnvironment)
  if (
    proof.serviceWasStopped !== true || proof.authDisabled !== true || proof.loopbackOnly !== true ||
    !Number.isInteger(proof.ownedProcessId) || proof.ownedProcessId < 2 || !isCanonicalProcessStartIdentity(proof.processStartIdentity, proof.ownedProcessId) ||
    proof.sessionToken.length < 16 || !proof.dbPathIdentity || !exactRecord(proof.resourceIds, identity.resourceIds)
  ) {
    throw new AgentStorageError('restore_failed', 'maintenance controller did not prove the exact owned stopped-service, volume and loopback-only no-auth target')
  }
  const { parsed, targets } = parseMongoAuthority(noAuthUri, false)
  if (targets.length !== 1 || !isLoopback(targets[0]!.host) || targets[0]!.port === 27017) throw new AgentStorageError('restore_failed', 'no-auth maintenance target must be one non-default loopback listener')
  if (parsed.searchParams.has('replicaSet') || parsed.searchParams.get('directConnection') !== 'true') throw new AgentStorageError('restore_failed', 'no-auth maintenance URI must select the owned standalone directly without replica-set discovery')
}

function assertNormalBaseUri(uri: string, identity: RestoreTargetIdentity, sourceEnvironment: string): URL {
  assertTargetEnvironment(identity, sourceEnvironment)
  const { parsed, targets } = parseMongoAuthority(uri, false)
  if (parsed.pathname !== '/' || parsed.searchParams.get('replicaSet') !== identity.replicaSet) throw new AgentStorageError('restore_failed', 'authenticated restart base URI must select the declared replica set without a database')
  if (targets.length !== 1 || `${targets[0]!.host}:${targets[0]!.port}` !== identity.memberEndpoint.toLowerCase()) throw new AgentStorageError('restore_failed', 'authenticated restart base URI must contain only the declared single normal member endpoint')
  return parsed
}

function uriForPrincipal(base: URL, principal: RestorePrincipalRotation, databaseName: string, selectDatabase: boolean = true): string {
  const value = new URL(base)
  value.username = ''
  value.password = ''
  value.pathname = selectDatabase ? `/${principal.kind === 'runtime' ? databaseName : 'admin'}` : '/'
  value.searchParams.set('authSource', principal.authDatabase)
  const serialized = value.toString()
  const prefix = 'mongodb://'
  if (!serialized.startsWith(prefix)) throw new AgentStorageError('restore_failed', 'normal MongoDB base URI is invalid')
  return `${prefix}${encodeURIComponent(principal.username)}:${encodeURIComponent(principal.newPassword)}@${serialized.slice(prefix.length)}`
}

async function prepareNoAuthTarget(input: {
  readonly noAuthUri: string
  readonly target: RestoreTargetIdentity
  readonly sourceDatabase: string
  readonly principals: readonly RestorePrincipalRotation[]
}): Promise<{
  readonly retiredPrincipals: readonly { readonly username: string; readonly authDatabase: string }[]
  readonly retiredRoles: readonly { readonly role: string; readonly database: string }[]
  readonly completedAt: Date
}> {
  const byKind = assertPrincipalRotations(input.principals, input.target.databaseName)
  const client = new MongoClient(input.noAuthUri, { appName: 'stokd-agent-offline-restore-preparer', serverSelectionTimeoutMS: 10_000 })
  await client.connect()
  try {
    const admin = client.db('admin')
    const hello = await admin.command({ hello: 1 }) as { readonly setName?: string; readonly isWritablePrimary?: boolean }
    if (hello.setName !== undefined || hello.isWritablePrimary !== true) {
      throw new AgentStorageError('restore_failed', 'no-auth preparation connection must be the owned writable standalone')
    }
    if (input.sourceDatabase === input.target.databaseName) throw new AgentStorageError('restore_failed', 'restored source and target database names must differ')

    const inventory = (await admin.admin().listDatabases({ nameOnly: true })).databases.map(value => value.name).sort()
    const unexpected = inventory.filter(name => !['admin', 'config', 'local', input.sourceDatabase, input.target.databaseName].includes(name))
    if (unexpected.length > 0) throw new AgentStorageError('restore_failed', 'isolated restore target contains unexpected application databases', { unexpected })

    const sourceDb = client.db(input.sourceDatabase)
    const targetDb = client.db(input.target.databaseName)
    const sourceCollections = (await sourceDb.listCollections({}, { nameOnly: true }).toArray()).map(value => value.name).filter(name => !name.startsWith('system.')).sort()
    if (sourceCollections.length === 0) throw new AgentStorageError('restore_failed', 'restored source database contains no application collections')
    await targetDb.dropDatabase()
    for (const name of sourceCollections) {
      await admin.command({ renameCollection: `${input.sourceDatabase}.${name}`, to: `${input.target.databaseName}.${name}`, dropTarget: false })
    }
    await sourceDb.dropDatabase()

    const users = await admin.command({ usersInfo: { forAllDBs: true }, showPrivileges: false }) as { readonly users?: readonly { readonly user: string; readonly db: string }[] }
    const roles = await admin.command({ rolesInfo: 1, showBuiltinRoles: false, showPrivileges: false }) as { readonly roles?: readonly { readonly role: string; readonly db: string }[] }
    const retiredPrincipals = (users.users ?? []).map(value => ({ username: value.user, authDatabase: value.db })).sort((a, b) => `${a.authDatabase}/${a.username}`.localeCompare(`${b.authDatabase}/${b.username}`))
    const retiredRoles = (roles.roles ?? []).map(value => ({ role: value.role, database: value.db })).sort((a, b) => `${a.database}/${a.role}`.localeCompare(`${b.database}/${b.role}`))
    const databasesWithSecurityState = new Set(['admin', input.sourceDatabase, input.target.databaseName, ...retiredPrincipals.map(value => value.authDatabase), ...retiredRoles.map(value => value.database)])
    for (const databaseName of databasesWithSecurityState) {
      const database = client.db(databaseName)
      await database.command({ dropAllUsersFromDatabase: 1 })
      await database.command({ dropAllRolesFromDatabase: 1 })
    }

    const migration = byKind.get('migration')!
    const definition = migration.roleDefinition!
    await admin.command({ createRole: definition.role, privileges: definition.privileges, roles: definition.roles })
    const runtime = byKind.get('runtime')!
    const backup = byKind.get('backup')!
    await client.db(runtime.authDatabase).command({ createUser: runtime.username, pwd: runtime.newPassword, roles: runtime.roles })
    await admin.command({ createUser: migration.username, pwd: migration.newPassword, roles: migration.roles })
    await admin.command({ createUser: backup.username, pwd: backup.newPassword, roles: backup.roles })

    const finalUsers = await admin.command({ usersInfo: { forAllDBs: true }, showPrivileges: false }) as { readonly users?: readonly { readonly user: string; readonly db: string; readonly roles: readonly RoleAssignment[] }[] }
    if ((finalUsers.users?.length ?? 0) !== RESTORE_PRINCIPAL_KINDS.length) throw new AgentStorageError('restore_failed', 'offline preparation did not leave exactly three steady-state principals')
    for (const principal of input.principals) {
      const user = finalUsers.users?.find(value => value.user === principal.username && value.db === principal.authDatabase)
      if (!user) throw new AgentStorageError('restore_failed', `offline preparation did not create ${principal.kind} principal`)
      assertExactRoles(user.roles, principal.roles, principal.kind)
    }
    const finalRoles = await admin.command({ rolesInfo: 1, showBuiltinRoles: false, showPrivileges: true }) as { readonly roles?: readonly { readonly role: string; readonly db: string; readonly roles: readonly RoleAssignment[]; readonly privileges: readonly { readonly resource: Readonly<Record<string, unknown>>; readonly actions: readonly string[] }[] }[] }
    const migrationRole = finalRoles.roles?.[0]
    const actualInheritedRoles = migrationRole?.roles.map(roleKey).sort() ?? []
    const expectedInheritedRoles = definition.roles.map(roleKey).sort()
    if (
      finalRoles.roles?.length !== 1 || migrationRole?.role !== definition.role || migrationRole.db !== 'admin' ||
      stableJson(actualInheritedRoles) !== stableJson(expectedInheritedRoles) || stableJson(migrationRole.privileges) !== stableJson(definition.privileges)
    ) {
      throw new AgentStorageError('restore_failed', 'offline preparation did not leave exactly the frozen target migration custom role', {
        roleCount: finalRoles.roles?.length ?? 0,
        observedRole: migrationRole?.role ?? null,
        observedDatabase: migrationRole?.db ?? null,
        observedInheritedRoles: actualInheritedRoles,
        observedPrivileges: migrationRole?.privileges ?? [],
      })
    }

    return {
      retiredPrincipals,
      retiredRoles,
      completedAt: await readServerTime(admin),
    }
  } finally {
    await client.close().catch(() => undefined)
  }
}

async function verifySteadyStatePrincipals(input: {
  readonly credentialUris: Readonly<Record<RestorePrincipalRotation['kind'], string>>
  readonly target: RestoreTargetIdentity
  readonly sourceEnvironment: string
  readonly sourceDatabase: string
  readonly expectedFeatureCompatibilityVersion: string
  readonly retiredArchivedPrincipals: readonly { readonly username: string; readonly authDatabase: string }[]
  readonly archivedCredentialProbes: readonly ArchivedCredentialProbe[]
}): Promise<{ readonly runtimeDb: Db; readonly runtimeClient: MongoClient; readonly rotatedAt: Date; readonly probeResults: readonly { readonly origin: ArchivedCredentialProbe['origin']; readonly kind: RestorePrincipalRotation['kind']; readonly rejected: true }[] }> {
  const expectedProbeKeys = new Set(['source_archive', 'target_pre_restore'].flatMap(origin => RESTORE_PRINCIPAL_KINDS.map(kind => `${origin}/${kind}`)))
  const actualProbeKeys = input.archivedCredentialProbes.map(value => `${value.origin}/${value.kind}`)
  if (actualProbeKeys.length !== expectedProbeKeys.size || new Set(actualProbeKeys).size !== expectedProbeKeys.size || actualProbeKeys.some(value => !expectedProbeKeys.has(value))) {
    throw new AgentStorageError('restore_failed', 'retired credential denial requires exactly one source-archive and target-pre-restore probe for each principal kind')
  }
  for (const uri of Object.values(input.credentialUris)) assertIsolatedTarget(uri, input.target, input.sourceEnvironment)

  const runtimeClient = new MongoClient(input.credentialUris.runtime, { appName: 'stokd-agent-restored-runtime', serverSelectionTimeoutMS: 10_000 })
  const migrationClient = new MongoClient(input.credentialUris.migration, { appName: 'stokd-agent-restored-migration-probe', serverSelectionTimeoutMS: 10_000 })
  const backupClient = new MongoClient(input.credentialUris.backup, { appName: 'stokd-agent-restored-backup-probe', serverSelectionTimeoutMS: 10_000 })
  try {
    await runtimeClient.connect()
    await migrationClient.connect()
    await backupClient.connect()
    const runtimeDb = runtimeClient.db(input.target.databaseName)
    const [runtimeHello, migrationFcv, backupHello] = await Promise.all([
      runtimeDb.admin().command({ hello: 1 }) as Promise<{ readonly setName?: string; readonly me?: string }>,
      migrationClient.db('admin').command({ getParameter: 1, featureCompatibilityVersion: 1 }),
      backupClient.db('admin').command({ hello: 1 }) as Promise<{ readonly setName?: string; readonly me?: string }>,
    ])
    if (
      runtimeHello.setName !== input.target.replicaSet || runtimeHello.me?.toLowerCase() !== input.target.memberEndpoint.toLowerCase() ||
      backupHello.setName !== input.target.replicaSet || backupHello.me?.toLowerCase() !== input.target.memberEndpoint.toLowerCase() ||
      (migrationFcv as { readonly featureCompatibilityVersion?: { readonly version?: string } }).featureCompatibilityVersion?.version !== input.expectedFeatureCompatibilityVersion
    ) {
      throw new AgentStorageError('restore_failed', 'steady-state target principal probes did not reach the declared target')
    }
    const probeResults: { origin: ArchivedCredentialProbe['origin']; kind: RestorePrincipalRotation['kind']; rejected: true }[] = []
    for (const probe of input.archivedCredentialProbes) {
      const uri = probe.uri
      assertIsolatedTarget(uri, input.target, input.sourceEnvironment)
      const parsed = new URL(uri)
      const username = decodeURIComponent(parsed.username)
      const expectedUsername = `agent_${probe.kind}`
      const selectedDatabase = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
      const credentialDatabase = probe.origin === 'source_archive' ? input.sourceDatabase : input.target.databaseName
      const expectedDatabase = probe.kind === 'backup' ? '' : credentialDatabase
      const expectedAuthSource = probe.kind === 'runtime' ? credentialDatabase : 'admin'
      if (username !== expectedUsername || selectedDatabase !== expectedDatabase || parsed.searchParams.get('authSource') !== expectedAuthSource) {
        throw new AgentStorageError('restore_failed', `archived ${probe.kind} credential probe has the wrong username, database or authSource`)
      }
      if (probe.origin === 'source_archive' && !input.retiredArchivedPrincipals.some(value => value.username === username && value.authDatabase === expectedAuthSource)) {
        throw new AgentStorageError('restore_failed', `archived ${probe.kind} credential was not present in the signed retired-principal inventory`)
      }
      const archived = new MongoClient(uri, { serverSelectionTimeoutMS: 2_000 })
      let authenticated = false
      try {
        await archived.connect()
        await archived.db('admin').command({ connectionStatus: 1 })
        authenticated = true
      } catch (error) {
        const mongoError = error as { readonly code?: unknown; readonly codeName?: unknown }
        if (mongoError.code !== 18 || mongoError.codeName !== 'AuthenticationFailed') {
          throw new AgentStorageError('restore_failed', `archived ${probe.kind} credential probe did not reach an authentication decision`, {
            kind: probe.kind,
            observedCode: typeof mongoError.code === 'number' ? mongoError.code : null,
            observedCodeName: typeof mongoError.codeName === 'string' ? mongoError.codeName : null,
          })
        }
        probeResults.push({ origin: probe.origin, kind: probe.kind, rejected: true })
      } finally {
        await archived.close().catch(() => undefined)
      }
      if (authenticated) throw new AgentStorageError('restore_failed', 'an archived source credential still authenticates after offline rotation')
    }
    return { runtimeDb, runtimeClient, rotatedAt: await readServerTime(runtimeDb), probeResults }
  } catch (error) {
    await runtimeClient.close().catch(() => undefined)
    throw error
  } finally {
    await migrationClient.close().catch(() => undefined)
    await backupClient.close().catch(() => undefined)
  }
}

async function assertManifestCustody(input: {
  readonly manifestBytes: Uint8Array
  readonly manifestCustody: ObjectCustodyRecord
  readonly archiveCustody: ObjectCustodyRecord
  readonly localArchivePath: string
  readonly requireVersionedObjectCustody: boolean
}): Promise<AgentBackupManifest> {
  const manifest = parseBackupManifestBytes(input.manifestBytes)
  const manifestSha256 = createHash('sha256').update(input.manifestBytes).digest('hex')
  if (input.manifestCustody.sha256 !== manifestSha256 || input.manifestCustody.byteLength !== input.manifestBytes.byteLength) {
    throw new AgentStorageError('restore_failed', 'backup manifest bytes do not match manifest custody')
  }
  if (input.manifestCustody.bucket !== manifest.sourceResourceIds.backupBucket || input.manifestCustody.kmsKeyId !== manifest.sourceResourceIds.kmsKeyArn) throw new AgentStorageError('restore_failed', 'manifest custody is outside the frozen source backup bucket or KMS key')
  const archive = manifest.archive
  if (stableJson(input.archiveCustody) !== stableJson(archive.custody)) throw new AgentStorageError('restore_failed', 'downloaded archive bucket, key, VersionId or custody does not match the backup manifest')
  const archiveStat = statSync(input.localArchivePath)
  if (!archiveStat.isFile() || archiveStat.size !== archive.byteLength || await sha256(input.localArchivePath) !== archive.sha256) {
    throw new AgentStorageError('restore_failed', 'downloaded local backup archive bytes do not match durable archive custody')
  }
  if (archive.custody.sha256 !== archive.sha256 || archive.custody.byteLength !== archive.byteLength) throw new AgentStorageError('restore_failed', 'archive custody does not match manifest bytes')
  if (input.requireVersionedObjectCustody) {
    const records = [archive.custody, input.manifestCustody, ...manifest.objects]
    if (manifest.custodyMode !== 's3_versioned' || records.some(record => !record.bucket || !record.objectKey || !record.versionId || !record.kmsKeyId)) {
      throw new AgentStorageError('restore_failed', 'restore requires exact versioned KMS object custody for manifest, archive and artifacts')
    }
  }
  if (manifest.objectManifestSha256 !== jsonSha256(manifest.objects)) throw new AgentStorageError('restore_failed', 'object manifest checksum mismatch')
  if (
    manifest.recoveryMethod.kind !== 'owned-loopback-noauth-maintenance' || manifest.recoveryMethod.version !== '1.0' ||
    manifest.recoveryMethod.requiresStoppedService !== true || manifest.recoveryMethod.noSteadyStateRecoveryPrincipal !== true
  ) {
    throw new AgentStorageError('restore_failed', 'backup manifest does not declare the frozen offline recovery lifecycle')
  }
  return manifest
}

export function parseBackupManifestBytes(bytes: Uint8Array): AgentBackupManifest {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new AgentStorageError('restore_failed', 'backup manifest is not valid UTF-8') }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new AgentStorageError('restore_failed', 'backup manifest is not valid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || JSON.stringify(parsed) !== text) {
    throw new AgentStorageError('restore_failed', 'backup manifest must use the frozen canonical JSON serializer without duplicate or unknown formatting')
  }
  const row = parsed as Record<string, unknown>
  const exactKeys = (value: unknown, keys: readonly string[], name: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentStorageError('restore_failed', `${name} must be an object`)
    const actual = Object.keys(value).sort()
    const expected = [...keys].sort()
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new AgentStorageError('restore_failed', `${name} fields do not match backup manifest schema 1.0`)
    return value as Record<string, unknown>
  }
  const nonempty = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || value.length === 0) throw new AgentStorageError('restore_failed', `${name} must be a nonempty string`)
    return value
  }
  const stringRecord = (value: unknown, name: string): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentStorageError('restore_failed', `${name} must be an object`)
    const record = exactKeys(value, Object.keys(value), name)
    if (Object.keys(record).length === 0 || Object.entries(record).some(([key, child]) => !key || typeof child !== 'string' || child.length === 0)) throw new AgentStorageError('restore_failed', `${name} must contain nonempty string keys and values`)
  }
  const custodyRecord = (value: unknown, name: string): void => {
    const record = exactKeys(value, ['bucket', 'objectKey', 'versionId', 'eTag', 'sha256', 'byteLength', 'kmsKeyId', 'capturedAt'], name)
    for (const key of ['bucket', 'objectKey', 'versionId', 'eTag', 'sha256', 'kmsKeyId', 'capturedAt']) nonempty(record[key], `${name}.${key}`)
    if (!Number.isSafeInteger(record.byteLength) || Number(record.byteLength) < 0 || Number.isNaN(Date.parse(String(record.capturedAt)))) throw new AgentStorageError('restore_failed', `${name} byte length or custody timestamp is invalid`)
  }
  exactKeys(row, ['schemaVersion', 'backupId', 'sourceEnvironment', 'sourceDatabase', 'sourceReplicaSet', 'sourceResourceIds', 'sourceSecretVersionIds', 'observedMemberEndpoint', 'observedDatabaseInventory', 'admissionQuiesceProof', 'recoveryMethod', 'dumpStartedAt', 'restorePoint', 'serverVersion', 'featureCompatibilityVersion', 'databaseToolsVersion', 'archive', 'objects', 'objectManifestSha256', 'custodyMode'], 'backup manifest')
  if (row.schemaVersion !== '1.0' || row.serverVersion !== MONGODB_SERVER_VERSION || row.featureCompatibilityVersion !== MONGODB_FCV || row.databaseToolsVersion !== MONGODB_DATABASE_TOOLS_VERSION) throw new AgentStorageError('restore_failed', 'backup manifest version pins are unsupported')
  for (const key of ['backupId', 'sourceEnvironment', 'sourceDatabase', 'sourceReplicaSet', 'observedMemberEndpoint', 'dumpStartedAt', 'objectManifestSha256']) nonempty(row[key], `backup manifest.${key}`)
  if (Number.isNaN(Date.parse(String(row.dumpStartedAt)))) throw new AgentStorageError('restore_failed', 'backup manifest dump start is invalid')
  if (!Array.isArray(row.observedDatabaseInventory) || row.observedDatabaseInventory.some(value => typeof value !== 'string')) throw new AgentStorageError('restore_failed', 'backup manifest database inventory is invalid')
  stringRecord(row.sourceResourceIds, 'backup manifest.sourceResourceIds')
  assertAgentResourceIds(row.sourceResourceIds as Readonly<Record<string, string>>, 'backup manifest source resource IDs', 'restore_failed')
  stringRecord(row.sourceSecretVersionIds, 'backup manifest.sourceSecretVersionIds')
  assertAgentSecretVersionIds(row.sourceSecretVersionIds as Readonly<Record<string, string>>, 'backup manifest source principal secret VersionIds', 'restore_failed')
  const quiesce = exactKeys(row.admissionQuiesceProof, ['schemaVersion', 'proofId', 'sourceEnvironment', 'apiDesiredCount', 'apiRunningCount', 'observedAt', 'expiresAt', 'sourceResourceIds'], 'backup manifest.admissionQuiesceProof')
  if (quiesce.schemaVersion !== '1.0' || quiesce.apiDesiredCount !== 0 || quiesce.apiRunningCount !== 0) throw new AgentStorageError('restore_failed', 'backup manifest admission quiesce proof is invalid')
  for (const key of ['proofId', 'sourceEnvironment', 'observedAt', 'expiresAt']) nonempty(quiesce[key], `backup manifest.admissionQuiesceProof.${key}`)
  stringRecord(quiesce.sourceResourceIds, 'backup manifest.admissionQuiesceProof.sourceResourceIds')
  const recovery = exactKeys(row.recoveryMethod, ['kind', 'version', 'requiresStoppedService', 'noSteadyStateRecoveryPrincipal'], 'backup manifest.recoveryMethod')
  if (recovery.kind !== 'owned-loopback-noauth-maintenance' || recovery.version !== '1.0' || recovery.requiresStoppedService !== true || recovery.noSteadyStateRecoveryPrincipal !== true) throw new AgentStorageError('restore_failed', 'backup manifest recovery method is unsupported')
  const restorePoint = exactKeys(row.restorePoint, ['kind', 'startedAt', 'completedAt'], 'backup manifest.restorePoint')
  if (restorePoint.kind !== 'observed-oplog-dump-interval' || Number.isNaN(Date.parse(nonempty(restorePoint.startedAt, 'backup manifest.restorePoint.startedAt'))) || Number.isNaN(Date.parse(nonempty(restorePoint.completedAt, 'backup manifest.restorePoint.completedAt')))) throw new AgentStorageError('restore_failed', 'backup manifest restore point is invalid')
  const archive = exactKeys(row.archive, ['format', 'fullReplicaSet', 'oplogIncluded', 'sha256', 'byteLength', 'custody'], 'backup manifest.archive')
  if (archive.format !== 'mongodump-archive-gzip' || archive.fullReplicaSet !== true || archive.oplogIncluded !== true || !Number.isSafeInteger(archive.byteLength) || Number(archive.byteLength) <= 0) throw new AgentStorageError('restore_failed', 'backup manifest archive shape is invalid')
  nonempty(archive.sha256, 'backup manifest.archive.sha256')
  custodyRecord(archive.custody, 'backup manifest.archive.custody')
  if (!Array.isArray(row.objects)) throw new AgentStorageError('restore_failed', 'backup manifest objects must be an array')
  row.objects.forEach((value, index) => custodyRecord(value, `backup manifest.objects[${index}]`))
  if (row.objectManifestSha256 !== jsonSha256(row.objects)) throw new AgentStorageError('restore_failed', 'backup manifest object checksum does not match the exact ordered custody list')
  const sourceIds = row.sourceResourceIds as Readonly<Record<string, string>>
  if (quiesce.sourceEnvironment !== row.sourceEnvironment || stableJson(quiesce.sourceResourceIds) !== stableJson(sourceIds)) throw new AgentStorageError('restore_failed', 'backup manifest quiesce proof does not bind the source environment and resources')
  const observedAt = Date.parse(String(quiesce.observedAt))
  const dumpStartedAt = Date.parse(String(row.dumpStartedAt))
  const restoreStartedAt = Date.parse(String(restorePoint.startedAt))
  const restoreCompletedAt = Date.parse(String(restorePoint.completedAt))
  const expiresAt = Date.parse(String(quiesce.expiresAt))
  if ([observedAt, dumpStartedAt, restoreStartedAt, restoreCompletedAt, expiresAt].some(Number.isNaN) || observedAt > dumpStartedAt || dumpStartedAt !== restoreStartedAt || restoreStartedAt > restoreCompletedAt || restoreCompletedAt >= expiresAt) throw new AgentStorageError('restore_failed', 'backup manifest quiesce and restore-point times are out of order')
  const archiveCustody = archive.custody as Readonly<Record<string, unknown>>
  if (archiveCustody.bucket !== sourceIds.backupBucket || archiveCustody.kmsKeyId !== sourceIds.kmsKeyArn) throw new AgentStorageError('restore_failed', 'backup archive custody is outside the source backup bucket or KMS key')
  for (const objectRecord of row.objects as readonly Readonly<Record<string, unknown>>[]) if (objectRecord.bucket !== sourceIds.artifactBucket || objectRecord.kmsKeyId !== sourceIds.kmsKeyArn) throw new AgentStorageError('restore_failed', 'backup artifact custody is outside the source artifact bucket or KMS key')
  if (row.custodyMode !== 'local_evidence' && row.custodyMode !== 's3_versioned') throw new AgentStorageError('restore_failed', 'backup manifest custody mode is unsupported')
  return parsed as AgentBackupManifest
}

export async function restoreBackupOffline(input: {
  readonly manifestBytes: Uint8Array
  readonly manifestCustody: ObjectCustodyRecord
  readonly archiveCustody: ObjectCustodyRecord
  readonly localArchivePath: string
  readonly mongorestorePath: string
  readonly target: RestoreTargetIdentity
  readonly principals: readonly RestorePrincipalRotation[]
  readonly noAuthUri: string
  readonly maintenanceProof: IsolatedRestoreMaintenanceProof
  readonly receiptSigningKey: Uint8Array
  readonly requireVersionedObjectCustody?: boolean
}): Promise<OfflineRestoreReceipt> {
  assertDatabaseToolVersion(input.mongorestorePath, 'mongorestore')
  const manifest = await assertManifestCustody({
    manifestBytes: input.manifestBytes,
    manifestCustody: input.manifestCustody,
    archiveCustody: input.archiveCustody,
    localArchivePath: input.localArchivePath,
    requireVersionedObjectCustody: input.requireVersionedObjectCustody !== false,
  })
  assertPrincipalRotations(input.principals, input.target.databaseName)
  assertTargetEnvironment(input.target, manifest.sourceEnvironment)
  if (Object.keys(input.target.resourceIds).length === 0 || Object.values(input.target.resourceIds).some(value => !value)) throw new AgentStorageError('restore_failed', 'target resource IDs are required')
  const sourceIds = new Set(Object.values(manifest.sourceResourceIds))
  if (Object.values(input.target.resourceIds).some(value => sourceIds.has(value))) throw new AgentStorageError('restore_failed', 'restore target reuses a source resource ID')
  assertNoAuthMaintenanceTarget(input.noAuthUri, input.maintenanceProof, input.target, manifest.sourceEnvironment)
  try {
    internalMongoTool.runToolWithConfig(
      input.mongorestorePath,
      input.noAuthUri,
      [`--archive=${input.localArchivePath}`, '--gzip', '--oplogReplay', '--drop'],
      input.localArchivePath.slice(0, input.localArchivePath.lastIndexOf('/')),
    )
  } catch (error) {
    throw new AgentStorageError('restore_failed', 'isolated no-auth mongorestore failed', { cause: error instanceof Error ? error.message : String(error) })
  }
  const prepared = await prepareNoAuthTarget({
    noAuthUri: input.noAuthUri,
    target: input.target,
    sourceDatabase: manifest.sourceDatabase,
    principals: input.principals,
  })
  const manifestSha256 = createHash('sha256').update(input.manifestBytes).digest('hex')
  const receiptId = `rof_${createHash('sha256').update(`${manifest.backupId}\0${input.target.environment}\0${manifestSha256}`).digest('hex').slice(0, 32)}`
  return signOfflineReceipt({
    schemaVersion: '1.0',
    receiptId,
    backupId: manifest.backupId,
    sourceEnvironment: manifest.sourceEnvironment,
    sourceDatabase: manifest.sourceDatabase,
    target: input.target,
    manifestSha256,
    archiveSha256: manifest.archive.sha256,
    objectManifestSha256: manifest.objectManifestSha256,
    principalCatalogSha256: principalCatalogSha256(input.principals),
    maintenanceProof: {
      ownedProcessId: input.maintenanceProof.ownedProcessId,
      processStartIdentity: input.maintenanceProof.processStartIdentity,
      dbPathIdentitySha256: createHash('sha256').update(input.maintenanceProof.dbPathIdentity).digest('hex'),
      resourceIds: input.maintenanceProof.resourceIds,
    },
    retiredArchivedPrincipals: prepared.retiredPrincipals,
    retiredArchivedRoles: prepared.retiredRoles,
    offlineCompletedAt: prepared.completedAt.toISOString(),
  }, input.receiptSigningKey)
}

export async function finalizeRestoredBackup(input: {
  readonly receipt: OfflineRestoreReceipt
  readonly receiptSigningKey: Uint8Array
  readonly manifestBytes: Uint8Array
  readonly manifestCustody: ObjectCustodyRecord
  readonly normalBaseUri: string
  readonly target: RestoreTargetIdentity
  readonly principals: readonly RestorePrincipalRotation[]
  readonly archivedCredentialProbes: readonly ArchivedCredentialProbe[]
  readonly objectTransport: ObjectRestoreTransport
  readonly afterObjectRestored?: (completedCount: number) => Promise<void> | void
}): Promise<RestoreReconciliationReport & { readonly target: RestoreTargetIdentity; readonly credentialRotation: RestoreCredentialRotationReceipt }> {
  const receipt = verifyOfflineReceipt(input.receipt, input.receiptSigningKey)
  const manifest = parseBackupManifestBytes(input.manifestBytes)
  const manifestSha256 = createHash('sha256').update(input.manifestBytes).digest('hex')
  if (
    receipt.backupId !== manifest.backupId || receipt.sourceEnvironment !== manifest.sourceEnvironment ||
    receipt.sourceDatabase !== manifest.sourceDatabase || receipt.manifestSha256 !== manifestSha256 ||
    receipt.archiveSha256 !== manifest.archive.sha256 || receipt.objectManifestSha256 !== manifest.objectManifestSha256 ||
    stableJson(receipt.target) !== stableJson(input.target) || !exactRecord(receipt.maintenanceProof.resourceIds, input.target.resourceIds)
  ) {
    throw new AgentStorageError('restore_failed', 'offline receipt does not bind the supplied backup manifest and target')
  }
  if (input.manifestCustody.sha256 !== manifestSha256 || input.manifestCustody.byteLength !== input.manifestBytes.byteLength) throw new AgentStorageError('restore_failed', 'manifest custody changed between offline restore and authenticated finalize')
  const byKind = assertPrincipalRotations(input.principals, input.target.databaseName)
  if (receipt.principalCatalogSha256 !== principalCatalogSha256(input.principals)) throw new AgentStorageError('restore_failed', 'steady-state principal catalog differs from the signed offline receipt')
  const normalBase = assertNormalBaseUri(input.normalBaseUri, input.target, manifest.sourceEnvironment)
  const credentialUris: Readonly<Record<RestorePrincipalRotation['kind'], string>> = {
    runtime: uriForPrincipal(normalBase, byKind.get('runtime')!, input.target.databaseName),
    migration: uriForPrincipal(normalBase, byKind.get('migration')!, input.target.databaseName),
    backup: uriForPrincipal(normalBase, byKind.get('backup')!, input.target.databaseName, false),
  }
  const verified = await verifySteadyStatePrincipals({
    credentialUris,
    target: input.target,
    sourceEnvironment: manifest.sourceEnvironment,
    sourceDatabase: manifest.sourceDatabase,
    expectedFeatureCompatibilityVersion: manifest.featureCompatibilityVersion,
    retiredArchivedPrincipals: receipt.retiredArchivedPrincipals,
    archivedCredentialProbes: input.archivedCredentialProbes,
  })
  try {
    if (verified.runtimeDb.databaseName !== input.target.databaseName) throw new AgentStorageError('restore_failed', 'runtime connection selected the wrong target database')
    await assertSchemaCompatibility(verified.runtimeDb, manifest.featureCompatibilityVersion)
    await verifyStorageCatalog(verified.runtimeDb)
    const restoreId = `rst_${createHash('sha256').update(`${manifest.backupId}\0${input.target.environment}`).digest('hex').slice(0, 32)}`
    const report = await enterRestoredObservationMode({
      db: verified.runtimeDb,
      manifest,
      restoreId,
      targetEnvironment: input.target.environment,
      objectTransport: input.objectTransport,
      dispatchObserver: new MongoDispatchBoundaryObserver(verified.runtimeDb),
      ...(input.afterObjectRestored ? { afterObjectRestored: input.afterObjectRestored } : {}),
    })
    if (report.objectVersionMappings.some(value => value.target.bucket !== input.target.resourceIds.artifactBucket || value.target.kmsKeyId !== input.target.resourceIds.kmsKeyArn)) throw new AgentStorageError('restore_failed', 'restored object mapping escaped the frozen target artifact bucket or KMS key')
    return {
      ...report,
      target: input.target,
      credentialRotation: {
        rotatedAt: verified.rotatedAt.toISOString(),
        principals: input.principals.map(value => ({ username: value.username, authDatabase: value.authDatabase, kind: value.kind, secretVersionId: value.secretVersionId })),
        retiredArchivedPrincipals: receipt.retiredArchivedPrincipals,
        retiredArchivedRoles: receipt.retiredArchivedRoles,
        archivedCredentialProbeResults: verified.probeResults,
        steadyStatePrincipalsOnly: true,
      },
    }
  } finally {
    await verified.runtimeClient.close()
  }
}

export async function restoreReplicaSetBackup(input: {
  readonly manifestBytes: Uint8Array
  readonly manifestCustody: ObjectCustodyRecord
  readonly archiveCustody: ObjectCustodyRecord
  readonly localArchivePath: string
  readonly mongorestorePath: string
  readonly target: RestoreTargetIdentity
  readonly principals: readonly RestorePrincipalRotation[]
  readonly archivedCredentialProbes: readonly ArchivedCredentialProbe[]
  readonly maintenanceController: IsolatedRestoreMaintenanceController
  readonly receiptSigningKey: Uint8Array
  readonly objectTransport: ObjectRestoreTransport
  readonly requireVersionedObjectCustody?: boolean
  readonly afterObjectRestored?: (completedCount: number) => Promise<void> | void
}): Promise<RestoreReconciliationReport & { readonly target: RestoreTargetIdentity; readonly credentialRotation: RestoreCredentialRotationReceipt; readonly offlineReceipt: OfflineRestoreReceipt }> {
  const maintenance = await input.maintenanceController.enter(input.target)
  let receipt: OfflineRestoreReceipt
  let normalBaseUri: string
  try {
    receipt = await restoreBackupOffline({
      manifestBytes: input.manifestBytes,
      manifestCustody: input.manifestCustody,
      archiveCustody: input.archiveCustody,
      localArchivePath: input.localArchivePath,
      mongorestorePath: input.mongorestorePath,
      target: input.target,
      principals: input.principals,
      noAuthUri: maintenance.noAuthUri,
      maintenanceProof: maintenance.proof,
      receiptSigningKey: input.receiptSigningKey,
      ...(input.requireVersionedObjectCustody === undefined ? {} : { requireVersionedObjectCustody: input.requireVersionedObjectCustody }),
    })
    normalBaseUri = (await maintenance.enableAuth()).normalBaseUri
  } finally {
    await maintenance.close()
  }
  const finalized = await finalizeRestoredBackup({
    receipt,
    receiptSigningKey: input.receiptSigningKey,
    manifestBytes: input.manifestBytes,
    manifestCustody: input.manifestCustody,
    normalBaseUri,
    target: input.target,
    principals: input.principals,
    archivedCredentialProbes: input.archivedCredentialProbes,
    objectTransport: input.objectTransport,
    ...(input.afterObjectRestored ? { afterObjectRestored: input.afterObjectRestored } : {}),
  })
  return { ...finalized, offlineReceipt: receipt }
}

export const internalRestoreValidation = { assertIsolatedTarget, assertNoAuthMaintenanceTarget, assertNormalBaseUri }

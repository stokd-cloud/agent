import { AgentStorageError } from './errors.js'

export const MONGODB_SERVER_VERSION = '7.0.29' as const
export const MONGODB_FCV = '7.0' as const
export const MONGODB_DRIVER_VERSION = '6.20.0' as const

export interface AgentStorageConfig {
  readonly uri: string
  readonly environment: string
  readonly databaseName?: string
  readonly expectedReplicaSet: string
  readonly expectedServerVersion?: string
  readonly expectedFeatureCompatibilityVersion?: string
  readonly applicationName?: string
  readonly connectTimeoutMS?: number
  readonly principal?: 'runtime' | 'migration'
}

export interface NormalizedAgentStorageConfig {
  readonly uri: string
  readonly environment: string
  readonly databaseName: string
  readonly expectedReplicaSet: string
  readonly expectedServerVersion: string
  readonly expectedFeatureCompatibilityVersion: string
  readonly applicationName: string
  readonly connectTimeoutMS: number
  readonly principal: 'runtime' | 'migration'
}

export function assertEnvironmentName(value: string): string {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(value)) {
    throw new AgentStorageError('invalid_storage_config', 'environment must match ^[a-z][a-z0-9-]{1,31}$')
  }
  if (value.includes('stokd')) {
    throw new AgentStorageError('invalid_storage_config', 'environment may not use the reserved stokd name')
  }
  return value
}

export function agentDatabaseName(environment: string): string {
  return `agent_${assertEnvironmentName(environment).replaceAll('-', '_')}`
}

function parseMongoUri(uri: string): URL {
  let parsed: URL
  try { parsed = new URL(uri) } catch {
    throw new AgentStorageError('invalid_storage_config', 'storage URI is not a valid MongoDB URI')
  }
  if (parsed.protocol !== 'mongodb:' && parsed.protocol !== 'mongodb+srv:') {
    throw new AgentStorageError('invalid_storage_config', 'storage URI must use mongodb or mongodb+srv')
  }
  if (!parsed.username || !parsed.password) {
    throw new AgentStorageError('invalid_storage_config', 'storage URI must use an authenticated database principal')
  }
  return parsed
}

export function normalizeStorageConfig(config: AgentStorageConfig): NormalizedAgentStorageConfig {
  const environment = assertEnvironmentName(config.environment)
  const databaseName = config.databaseName ?? agentDatabaseName(environment)
  if (databaseName !== agentDatabaseName(environment) || !/^agent_[a-z0-9_]+$/.test(databaseName)) {
    throw new AgentStorageError('invalid_storage_config', `database must be the isolated Agent database ${agentDatabaseName(environment)}`)
  }
  const parsed = parseMongoUri(config.uri)
  const uriDatabase = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (uriDatabase !== databaseName) {
    throw new AgentStorageError('invalid_storage_config', `URI database ${uriDatabase} does not match ${databaseName}`)
  }
  const authSource = parsed.searchParams.get('authSource')
  const principal = config.principal ?? 'runtime'
  if (principal === 'runtime' && authSource !== databaseName) {
    throw new AgentStorageError('invalid_storage_config', 'runtime storage credentials must authenticate against the Agent database')
  }
  if (principal === 'migration' && authSource !== 'admin') {
    throw new AgentStorageError('invalid_storage_config', 'migration credentials must authenticate against admin for the explicit FCV privilege')
  }
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(config.expectedReplicaSet)) {
    throw new AgentStorageError('invalid_storage_config', 'expectedReplicaSet is invalid')
  }
  return {
    uri: config.uri,
    environment,
    databaseName,
    expectedReplicaSet: config.expectedReplicaSet,
    expectedServerVersion: config.expectedServerVersion ?? MONGODB_SERVER_VERSION,
    expectedFeatureCompatibilityVersion: config.expectedFeatureCompatibilityVersion ?? MONGODB_FCV,
    applicationName: config.applicationName ?? 'stokd-agent-storage',
    connectTimeoutMS: config.connectTimeoutMS ?? 10_000,
    principal,
  }
}

export function redactedMongoUri(uri: string): string {
  const parsed = parseMongoUri(uri)
  parsed.username = '<redacted>'
  parsed.password = '<redacted>'
  return parsed.toString()
}

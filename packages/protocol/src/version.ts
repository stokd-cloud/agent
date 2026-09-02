
import { AgentProtocolError, unsupportedError } from './errors.js'

export const AGENT_PROTOCOL_VERSION = '1.0' as const
export const AGENT_PROTOCOL_MAJOR = 1 as const
export const AGENT_PROTOCOL_MINOR = 0 as const

export interface ParsedSchemaVersion {
  readonly raw: string
  readonly major: number
  readonly minor: number
}

export function parseSchemaVersion(value: unknown): ParsedSchemaVersion {
  if (typeof value !== 'string') {
    throw new AgentProtocolError(unsupportedError('schemaVersion must be a major.minor string', 'unsupported_schema_version'))
  }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  if (!match) {
    throw new AgentProtocolError(unsupportedError(`invalid schemaVersion: ${value}`, 'unsupported_schema_version'))
  }
  return { raw: value, major: Number(match[1]), minor: Number(match[2]) }
}

export function assertSupportedMajor(value: unknown): ParsedSchemaVersion {
  const parsed = parseSchemaVersion(value)
  if (parsed.major !== AGENT_PROTOCOL_MAJOR) {
    throw new AgentProtocolError(unsupportedError(
      `unsupported agent protocol major ${parsed.major}; supported major is ${AGENT_PROTOCOL_MAJOR}`,
      'unsupported_schema_version',
      { received: parsed.raw, supported: AGENT_PROTOCOL_VERSION },
    ))
  }
  return parsed
}

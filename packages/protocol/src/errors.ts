
export const EXIT_CODES = {
  success: 0,
  usage: 2,
  authorization: 3,
  missing: 4,
  conflict: 5,
  runtime: 6,
  unsupported: 7,
} as const

export type AgentExitCode = typeof EXIT_CODES[keyof typeof EXIT_CODES]
export type AgentErrorExitCode = Exclude<AgentExitCode, 0>

export type AgentErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'revision_conflict'
  | 'runtime_unavailable'
  | 'unsupported_capability'
  | 'unsupported_schema_version'
  | 'unknown_state_changing_event'

export interface AgentErrorEnvelope {
  readonly schemaVersion: '1.0'
  readonly errorId: string
  readonly code: AgentErrorCode
  readonly message: string
  readonly exitCode: AgentErrorExitCode
  readonly retryable: boolean
  readonly details?: Readonly<Record<string, unknown>>
}

export class AgentProtocolError extends Error {
  readonly envelope: AgentErrorEnvelope

  constructor(envelope: AgentErrorEnvelope) {
    super(envelope.message)
    this.name = 'AgentProtocolError'
    this.envelope = envelope
  }
}

function errorId(code: AgentErrorCode): string {
  return `err_${code}`
}

export function unsupportedError(
  message: string,
  code: Extract<AgentErrorCode, 'unsupported_capability' | 'unsupported_schema_version' | 'unknown_state_changing_event'> = 'unsupported_capability',
  details?: Readonly<Record<string, unknown>>,
): AgentErrorEnvelope {
  return {
    schemaVersion: '1.0',
    errorId: errorId(code),
    code,
    message,
    exitCode: EXIT_CODES.unsupported,
    retryable: false,
    ...(details ? { details } : {}),
  }
}

export function invalidRequestError(message: string): AgentErrorEnvelope {
  return {
    schemaVersion: '1.0',
    errorId: errorId('invalid_request'),
    code: 'invalid_request',
    message,
    exitCode: EXIT_CODES.usage,
    retryable: false,
  }
}

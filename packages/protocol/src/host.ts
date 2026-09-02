
import type { HostId } from './ids.js'

export interface HostCapabilityDescriptor {
  readonly schemaVersion: '1.0'
  readonly hostId: HostId
  readonly platform: string
  readonly architecture: string
  readonly nodeVersion: string
  readonly containerEngine: 'docker' | 'podman' | 'none'
  readonly modelProviders: readonly string[]
  readonly repositoryBindings: readonly string[]
  readonly capabilities: readonly string[]
  readonly observedAt: string
}


import type { AgentId, ArtifactId, ArtifactVersionId } from './ids.js'

export interface ArtifactVersionDescriptor {
  readonly schemaVersion: '1.0'
  readonly artifactId: ArtifactId
  readonly versionId: ArtifactVersionId
  readonly agentId: AgentId
  readonly safeFilename: string
  readonly contentType: string
  readonly byteLength: number
  readonly sha256: string
  readonly objectKey: string
  readonly createdAt: string
  readonly tombstonedAt?: string
}

export interface ArtifactReference {
  readonly schemaVersion: '1.0'
  readonly artifact: ArtifactVersionDescriptor
  readonly downloadUrl?: string
  readonly expiresAt?: string
}

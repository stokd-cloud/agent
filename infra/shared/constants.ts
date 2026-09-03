export const AGENT_AWS_ACCOUNT_ID = '167217327520' as const
export const AGENT_AWS_REGION = 'us-east-1' as const
export const AGENT_HOSTED_ZONE_ID = 'Z0974146XEXJDMNXU573' as const
export const AGENT_HOSTED_ZONE_NAME = 'stokd.cloud' as const
export const AGENT_DEPLOY_ROLE_NAME = 'stokd-agent-validation-deploy' as const
export const AGENT_DEPLOY_ROLE_ARN = `arn:aws:iam::${AGENT_AWS_ACCOUNT_ID}:role/${AGENT_DEPLOY_ROLE_NAME}` as const
export const AGENT_GITHUB_OIDC_SUBJECT = 'repo:stokd-cloud/agent:environment:agent-validation' as const
export const AGENT_GITHUB_VALIDATION_BRANCH = 'project/d7f02e6-cloud-agents-mvp' as const
export const AGENT_INFRA_MANIFEST_VERSION = 1 as const

export type AgentValidationStage = 'source-val12' | 'restore-val12'

export interface AgentStageIdentity {
  readonly stage: AgentValidationStage
  readonly domain: 'agent-source-val12.stokd.cloud' | 'agent-restore-val12.stokd.cloud'
  readonly databaseName: 'agent_source_val12' | 'agent_restore_val12'
  readonly recoveryMode: 'active' | 'restored_observation'
}

export const AGENT_STAGE_IDENTITIES: Readonly<Record<AgentValidationStage, AgentStageIdentity>> = {
  'source-val12': {
    stage: 'source-val12',
    domain: 'agent-source-val12.stokd.cloud',
    databaseName: 'agent_source_val12',
    recoveryMode: 'active',
  },
  'restore-val12': {
    stage: 'restore-val12',
    domain: 'agent-restore-val12.stokd.cloud',
    databaseName: 'agent_restore_val12',
    recoveryMode: 'restored_observation',
  },
}

export function resolveAgentStage(stage: string): AgentStageIdentity {
  const identity = AGENT_STAGE_IDENTITIES[stage as AgentValidationStage]
  if (!identity) throw new Error(`unsupported Agent validation stage: ${stage}`)
  return identity
}

export function infrastructureManifestParameter(stage: AgentValidationStage): string {
  return `/stokd-agent/${stage}/infrastructure-manifest/v1`
}

export function artifactBucketName(stage: AgentValidationStage): string {
  return `stokd-agent-artifacts-${stage}-${AGENT_AWS_ACCOUNT_ID}`
}

export function backupBucketName(stage: AgentValidationStage): string {
  return `stokd-agent-backups-${stage}-${AGENT_AWS_ACCOUNT_ID}`
}

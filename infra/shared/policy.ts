import { AGENT_AWS_ACCOUNT_ID, AGENT_AWS_REGION, type AgentValidationStage } from './constants'

export const workloadBoundaryArn = `arn:aws:iam::${AGENT_AWS_ACCOUNT_ID}:policy/stokd-agent-workload-boundary`

export function agentTags(stage: AgentValidationStage, custody: 'persistent' | 'runtime' | 'stateless' = 'runtime') {
  return { Project: 'stokd-agent', Stage: stage, Custody: custody, ManagedBy: 'sst-3.19.3' }
}

export function ecsTaskTrustPolicy(): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }],
  })
}

export function ec2TrustPolicy(): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
  })
}

export function executionPolicy(repositoryArn: string, logGroupArn: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Sid: 'AuthenticateEcr', Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
      { Sid: 'ReadPinnedImages', Effect: 'Allow', Action: ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'], Resource: repositoryArn },
      { Sid: 'WriteExactLogs', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: `${logGroupArn}:*` },
    ],
  })
}

export function exactSecretArn(stage: AgentValidationStage, kind: 'runtime' | 'migration' | 'backup'): string {
  return `arn:aws:secretsmanager:${AGENT_AWS_REGION}:${AGENT_AWS_ACCOUNT_ID}:secret:stokd-agent-${stage}-${kind}-*`
}

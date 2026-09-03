import { AGENT_AWS_ACCOUNT_ID, AGENT_AWS_REGION, AGENT_DEPLOY_ROLE_NAME, resolveAgentStage } from './constants'

export async function assertSstDeploymentIdentity(stage: string): Promise<void> {
  resolveAgentStage(stage)
  if (process.env.AGENT_AWS_ACCOUNT_ID !== AGENT_AWS_ACCOUNT_ID) {
    throw new Error(`AGENT_AWS_ACCOUNT_ID must equal ${AGENT_AWS_ACCOUNT_ID}`)
  }
  const configuredRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
  if (configuredRegion !== AGENT_AWS_REGION) throw new Error(`AWS region must equal ${AGENT_AWS_REGION}`)
  const [identity, region] = await Promise.all([aws.getCallerIdentity({}), aws.getRegion({})])
  if (identity.accountId !== AGENT_AWS_ACCOUNT_ID || region.name !== AGENT_AWS_REGION) {
    throw new Error('SST provider account or region does not match the Agent validation boundary')
  }
  if (identity.arn === `arn:aws:iam::${AGENT_AWS_ACCOUNT_ID}:root` || identity.arn.endsWith(':root')) {
    throw new Error('AWS account root is forbidden for Agent SST applications')
  }
  const assumedPrefix = `arn:aws:sts::${AGENT_AWS_ACCOUNT_ID}:assumed-role/${AGENT_DEPLOY_ROLE_NAME}/`
  const directRole = `arn:aws:iam::${AGENT_AWS_ACCOUNT_ID}:role/${AGENT_DEPLOY_ROLE_NAME}`
  if (identity.arn !== directRole && !identity.arn.startsWith(assumedPrefix)) {
    throw new Error(`SST requires the bounded ${AGENT_DEPLOY_ROLE_NAME} role`)
  }
}

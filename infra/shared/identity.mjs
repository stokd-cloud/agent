export const EXPECTED_ACCOUNT_ID = '167217327520'
export const EXPECTED_REGION = 'us-east-1'
export const DEPLOY_ROLE_NAME = 'stokd-agent-validation-deploy'

export function parseCallerIdentity(raw) {
  let parsed
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    throw new Error('AWS caller identity was not valid JSON')
  }
  if (!parsed || typeof parsed.Account !== 'string' || typeof parsed.Arn !== 'string') {
    throw new Error('AWS caller identity omitted Account or Arn')
  }
  return { account: parsed.Account, arn: parsed.Arn, userId: String(parsed.UserId ?? '') }
}

export function assertBoundedDeploymentIdentity(identity, environment = process.env) {
  if (environment.AGENT_AWS_ACCOUNT_ID !== EXPECTED_ACCOUNT_ID) {
    throw new Error(`AGENT_AWS_ACCOUNT_ID must equal ${EXPECTED_ACCOUNT_ID}`)
  }
  const region = environment.AWS_REGION || environment.AWS_DEFAULT_REGION
  if (region !== EXPECTED_REGION) throw new Error(`AWS region must equal ${EXPECTED_REGION}`)
  if (identity.account !== EXPECTED_ACCOUNT_ID) {
    throw new Error(`AWS account ${identity.account} is not the Agent validation account`)
  }
  if (identity.arn === `arn:aws:iam::${EXPECTED_ACCOUNT_ID}:root` || identity.arn.endsWith(':root')) {
    throw new Error('AWS account root is forbidden for Agent infrastructure actions')
  }
  const roleArnPrefix = `arn:aws:sts::${EXPECTED_ACCOUNT_ID}:assumed-role/${DEPLOY_ROLE_NAME}/`
  const directRoleArn = `arn:aws:iam::${EXPECTED_ACCOUNT_ID}:role/${DEPLOY_ROLE_NAME}`
  if (identity.arn !== directRoleArn && !identity.arn.startsWith(roleArnPrefix)) {
    throw new Error(`AWS caller must be the bounded ${DEPLOY_ROLE_NAME} role`)
  }
  return identity
}

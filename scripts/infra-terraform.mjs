// Terraform executor for the Agent validation stages (AX-CLOUD-TERRAFORM).
//
// Replaces the SST CLI as the thing that actually mutates cloud state. The
// surrounding safety machinery in infra-action.mjs is unchanged: bounded deploy
// identity, mutation lock and the resource-bound destruction acknowledgement all
// still gate this.
//
// The SST layout had two apps (data, api) because the API app had to read the
// data app's manifest out of SSM to discover its resources. Terraform resolves
// those references directly, so both map onto one root module. Apply is
// declarative and idempotent, so the pipeline's existing data-then-api phase
// order still works: the second invocation is a no-op when nothing changed.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const TERRAFORM_ACTIONS = Object.freeze({
  diff: 'plan',
  deploy: 'apply',
  remove: 'destroy',
})

export const AGENT_ACCOUNT_ID = '167217327520'
export const AGENT_REGION = 'us-east-1'

export function terraformRoot(root) {
  return resolve(root, 'infra', 'terraform')
}

/**
 * Backend settings are required, never defaulted: `terraform init` with an
 * empty `backend "s3" {}` block would otherwise fall back to local state.
 */
export function backendConfig(stage, environment) {
  const bucket = environment.AGENT_TFSTATE_BUCKET
  const kmsKeyId = environment.AGENT_TFSTATE_KMS_KEY_ID
  if (!bucket) throw new Error('terraform refused: AGENT_TFSTATE_BUCKET is required (encrypted remote state)')
  if (!kmsKeyId) throw new Error('terraform refused: AGENT_TFSTATE_KMS_KEY_ID is required (encrypted remote state)')
  return [
    `-backend-config=bucket=${bucket}`,
    `-backend-config=key=work-1.2/${stage}/terraform.tfstate`,
    `-backend-config=region=${AGENT_REGION}`,
    `-backend-config=kms_key_id=${kmsKeyId}`,
    '-backend-config=encrypt=true',
  ]
}

export function planArguments(stage, action) {
  const varFile = `-var-file=envs/${stage}.tfvars`
  const common = [varFile, '-input=false', `-var=stage=${stage}`]
  if (action === 'plan') return ['plan', ...common, '-lock-timeout=300s']
  if (action === 'apply') return ['apply', ...common, '-auto-approve', '-lock-timeout=300s']
  return ['destroy', ...common, '-auto-approve', '-lock-timeout=300s']
}

/**
 * Exact image digests and the source commit are passed as variables rather than
 * read from the environment inside Terraform, so a plan is reproducible from
 * its arguments alone.
 */
export function variableArguments(environment) {
  const values = {
    source_digest: environment.AGENT_SOURCE_DIGEST,
    api_image: environment.AGENT_API_IMAGE,
    mongo_image: environment.AGENT_MONGO_IMAGE,
    maintenance_image: environment.AGENT_MAINTENANCE_IMAGE,
  }
  const missing = Object.entries(values).filter(([, value]) => !value).map(([name]) => name)
  if (missing.length) throw new Error(`terraform refused: missing exact pinned inputs: ${missing.join(', ')}`)
  return Object.entries(values).map(([name, value]) => `-var=${name}=${value}`)
}

export function runTerraform(input, environment, spawn = spawnSync) {
  const action = TERRAFORM_ACTIONS[input.action]
  if (!action) throw new Error(`terraform refused: unsupported action '${input.action}'`)
  const cwd = terraformRoot(input.root)
  if (!existsSync(resolve(cwd, 'versions.tf'))) throw new Error(`terraform refused: no root module at ${cwd}`)

  const env = {
    ...environment,
    AGENT_AWS_ACCOUNT_ID: AGENT_ACCOUNT_ID,
    AWS_REGION: AGENT_REGION,
    AWS_DEFAULT_REGION: AGENT_REGION,
    TF_IN_AUTOMATION: '1',
  }

  const init = spawn('terraform', ['init', '-input=false', '-reconfigure', ...backendConfig(input.stage, environment)], {
    cwd, env, stdio: 'inherit',
  })
  if (init.error) throw init.error
  if ((init.status ?? 1) !== 0) return init.status ?? 1

  const child = spawn('terraform', [...planArguments(input.stage, action), ...variableArguments(environment)], {
    cwd, env, stdio: 'inherit',
  })
  if (child.error) throw child.error
  return child.status ?? 1
}

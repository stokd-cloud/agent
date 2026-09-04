// Enforces AX-CLOUD-TERRAFORM: Terraform is the sole durable IaC substrate for
// stokd-cloud/agent. The SST/CloudFormation layout is historical scaffold —
// reference-only, never deployed, never extended.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const terraformDir = join(root, 'infra/terraform')

assert.ok(existsSync(terraformDir), 'infra/terraform is the required IaC substrate and is missing')

const required = [
  'versions.tf', 'variables.tf', 'locals.tf', 'backend.tf',
  'network.tf', 'custody.tf', 'secrets.tf', 'mongo.tf', 'api.tf',
  'manifest.tf', 'outputs.tf',
]
for (const file of required) {
  assert.ok(existsSync(join(terraformDir, file)), `infra/terraform/${file} is missing`)
}

const tf = Object.fromEntries(
  readdirSync(terraformDir).filter(name => name.endsWith('.tf')).map(name => [name, readFileSync(join(terraformDir, name), 'utf8')]),
)
const allTf = Object.values(tf).join('\n')

// ── Retained custody must be undeletable by a plain destroy ───────────────────
// Each of these holds customer state. prevent_destroy is what turns
// "teardown refuses unacknowledged persistent-data deletion" into a mechanism.
const persistentResources = [
  ['custody.tf', 'aws_kms_key', 'data'],
  ['custody.tf', 'aws_kms_alias', 'data'],
  ['custody.tf', 'aws_s3_bucket', 'custody'],
  ['mongo.tf', 'aws_ebs_volume', 'data'],
  ['secrets.tf', 'aws_cloudformation_stack', 'credentials'],
  ['manifest.tf', 'aws_ssm_parameter', 'infrastructure_manifest'],
]
for (const [file, type, name] of persistentResources) {
  const source = tf[file]
  assert.ok(source, `${file} is missing`)
  const block = source.match(new RegExp(`resource "${type}" "${name}" \\{[\\s\\S]*?\\n\\}`, 'm'))
  assert.ok(block, `${type}.${name} not found in ${file}`)
  assert.match(
    block[0],
    /lifecycle\s*\{[\s\S]*?prevent_destroy\s*=\s*true/m,
    `${type}.${name} holds retained custody and must declare lifecycle.prevent_destroy = true`,
  )
}

// ── The host may not boot before it can reach anything ───────────────────────
// user_data pulls every host script from S3 at boot. Nothing in the
// configuration references a security-group rule, so without an explicit
// dependency Terraform is free to create the instance first -- it boots with no
// egress, the download fails, and the host has no scripts to run.
{
  const block = tf['mongo.tf'].match(/resource "aws_instance" "mongo" \{[\s\S]*?\n\}/m)
  assert.ok(block, 'aws_instance.mongo not found in mongo.tf')
  for (const rule of [
    'aws_vpc_security_group_ingress_rule.endpoints_from_mongo',
    'aws_vpc_security_group_egress_rule.mongo_to_endpoints',
    'aws_vpc_security_group_egress_rule.dns_udp',
    'aws_vpc_security_group_egress_rule.dns_tcp',
    'aws_vpc_security_group_egress_rule.s3_endpoint',
  ]) {
    assert.ok(block[0].includes(rule), `aws_instance.mongo must depend on ${rule}`)
  }
}

// ── No model-invoke authority on any workload identity ────────────────────────
// The permissions boundary already withholds it by omission; the explicit deny
// makes an IAM simulation report explicitDeny rather than implicitDeny.
const workloadRoles = [
  ['mongo.tf', 'aws_iam_role', 'mongo'],
  ['api.tf', 'aws_iam_role', 'api_execution'],
  ['api.tf', 'aws_iam_role', 'api_task'],
]
for (const [file, type, name] of workloadRoles) {
  const block = tf[file].match(new RegExp(`resource "${type}" "${name}" \\{[\\s\\S]*?\\n\\}`, 'm'))
  assert.ok(block, `${type}.${name} not found in ${file}`)
  assert.match(
    block[0],
    /permissions_boundary\s*=\s*local\.boundary_arn/,
    `${type}.${name} must carry the workload permissions boundary`,
  )
}

const denyDocuments = ['data.aws_iam_policy_document.mongo', 'api_execution', 'api_task']
assert.equal(
  (allTf.match(/sid\s*=\s*"NoModelInvocation"/g) ?? []).length,
  denyDocuments.length,
  'every workload policy document must carry a NoModelInvocation deny statement',
)
for (const action of ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']) {
  assert.equal(
    (allTf.match(new RegExp(`"${action}"`, 'g')) ?? []).length,
    denyDocuments.length,
    `${action} must be denied in every workload policy document`,
  )
}

// ── Endpoint-only egress ──────────────────────────────────────────────────────
// A NAT gateway or Elastic IP would put the Agent data plane on the public
// internet, which is exactly what the endpoint-only topology exists to prevent.
assert.doesNotMatch(allTf, /resource\s+"aws_nat_gateway"/, 'endpoint-only topology must declare no NAT gateway')
assert.doesNotMatch(allTf, /resource\s+"aws_eip"/, 'endpoint-only topology must declare no Elastic IP')

// ── Stage identity may not drift from the TypeScript source ───────────────────
const constants = readFileSync(join(root, 'infra/shared/constants.ts'), 'utf8')
for (const literal of [
  '167217327520', 'us-east-1', 'Z0974146XEXJDMNXU573',
  'stokd-agent-validation-deploy',
  'agent-source-val12.stokd.cloud', 'agent-restore-val12.stokd.cloud',
  'agent_source_val12', 'agent_restore_val12',
  'restored_observation',
]) {
  assert.ok(constants.includes(literal), `constants.ts unexpectedly lost ${literal}`)
  assert.ok(tf['locals.tf'].includes(literal), `locals.tf must mirror constants.ts value ${literal}`)
}

// ── The SST scaffold is frozen ────────────────────────────────────────────────
// New SST-owned product runtime is forbidden. This list may shrink as the
// scaffold is retired; it may not grow.
const allowedSstConfigs = new Set([
  'infra/api/sst.config.ts',
  'infra/data/sst.config.ts',
  'infra/bootstrap/empty-state.sst.config.ts',
])
const foundSstConfigs = []
const walk = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.sst') continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('sst.config.ts')) foundSstConfigs.push(full.slice(root.length + 1))
  }
}
walk(join(root, 'infra'))
for (const found of foundSstConfigs) {
  assert.ok(allowedSstConfigs.has(found), `new SST-owned runtime ${found} is forbidden by AX-CLOUD-TERRAFORM`)
}

// ── Credentials are generated inside AWS, never by the deployer ───────────────
// Secrets Manager's GenerateSecretString is reachable only through
// CloudFormation, so the credential stack is a deliberate escape hatch. What
// matters is that no Terraform-side generator puts plaintext into state.
assert.doesNotMatch(
  allTf,
  /resource\s+"random_password"/,
  'service credentials must be generated inside AWS, not by a Terraform generator that lands plaintext in state',
)
assert.doesNotMatch(
  allTf,
  /resource\s+"aws_secretsmanager_secret_version"/,
  'writing a secret version from Terraform would place the plaintext in state',
)
assert.match(
  tf['secrets.tf'],
  /resource\s+"aws_cloudformation_stack"\s+"credentials"/,
  'the credential stack must be managed by Terraform',
)
assert.match(tf['secrets.tf'], /GenerateSecretString/, 'credentials must use server-side GenerateSecretString')
for (const policy of ['DeletionPolicy', 'UpdateReplacePolicy']) {
  assert.match(tf['secrets.tf'], new RegExp(`${policy}\\s*=\\s*"Retain"`), `credential secrets must set ${policy}: Retain`)
}

// ── Handoff artifacts required by AC-1.2.b ────────────────────────────────────
const inventoryPath = join(terraformDir, 'handoff/import-inventory.json')
const contractPath = join(terraformDir, 'handoff/BEHAVIORAL-CONTRACT.md')
assert.ok(existsSync(inventoryPath), 'AC-1.2.b requires the Terraform physical-resource/import inventory')
assert.ok(existsSync(contractPath), 'AC-1.2.b requires the Terraform behavioral-contract handoff')

const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'))
assert.equal(inventory.workItem, '1.2')
assert.deepEqual(inventory.stages, ['source-val12', 'restore-val12'])
assert.ok(inventory.externallyOwned?.resources?.length > 0, 'inventory must enumerate externally-owned bootstrap resources')
assert.ok(inventory.managed?.custody?.resources?.length > 0, 'inventory must enumerate retained custody resources')

// Every resource the Terraform marks prevent_destroy must appear in the
// inventory's custody section, so the handoff cannot silently omit one.
const custodyAddresses = new Set(inventory.managed.custody.resources.map(entry => entry.address))
for (const [, type, name] of persistentResources) {
  const matches = [...custodyAddresses].some(address => address.startsWith(`${type}.${name}`))
  assert.ok(matches, `retained resource ${type}.${name} is missing from the handoff custody inventory`)
}

console.log(JSON.stringify({
  ok: true,
  check: 'terraform-substrate',
  terraformFiles: Object.keys(tf).sort(),
  persistentResources: persistentResources.map(([, type, name]) => `${type}.${name}`),
  sstConfigsFrozenAt: [...allowedSstConfigs].sort(),
}))

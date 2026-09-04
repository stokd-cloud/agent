import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertImageProvenance, expectedImageProvenance } from '../../scripts/infra-publish-images.mjs'
import { assertGitHubEnvironment, ensureGitHubEnvironment } from '../../scripts/infra-github-environment.mjs'
import { assertExactSstHomePolicy } from '../../scripts/infra-control-plane-readback.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const requireFromTui = createRequire(resolve(root, 'packages/tui/package.json'))
const { parseDocument } = requireFromTui('yaml')
const read = path => readFileSync(resolve(root, path), 'utf8')
const bootstrap = read('infra/bootstrap/template.yaml')
const workflow = read('.github/workflows/agent-validation.yml')
const mongoEntrypoint = read('infra/runtime/mongo-entrypoint.sh')
const imagePublisher = read('scripts/infra-publish-images.mjs')
const dataInfrastructure = read('infra/data/sst.config.ts')
const apiInfrastructure = read('infra/api/sst.config.ts')
const bootstrapDocument = parseDocument(bootstrap, { customTags: [
  { tag: '!Ref', resolve: value => value },
  { tag: '!Sub', resolve: value => value },
  { tag: '!GetAtt', resolve: value => value },
] })
assert.deepEqual(bootstrapDocument.errors, [], 'bootstrap template must parse as YAML')
const bootstrapValue = bootstrapDocument.toJS()

function statement(sid) {
  const match = new RegExp(`^(\\s*)- Sid: ${sid}\\n`, 'm').exec(bootstrap)
  assert(match, `missing IAM statement ${sid}`)
  const start = match.index
  const remainder = bootstrap.slice(start + match[0].length)
  const next = new RegExp(`^${match[1]}- Sid: `, 'm').exec(remainder)
  return bootstrap.slice(start, next ? start + match[0].length + next.index : undefined)
}

function policyStatement(policyLogicalId, sid) {
  const statements = bootstrapValue.Resources[policyLogicalId].Properties.PolicyDocument.Statement
  const matches = statements.filter(value => value.Sid === sid)
  assert.equal(matches.length, 1, `${policyLogicalId} must contain exactly one ${sid} statement`)
  return matches[0]
}

function resolvePolicyDocument(policyDocument) {
  const resolved = JSON.parse(JSON.stringify(policyDocument)
    .replaceAll('${ExistingSstStateBucketName}', 'sst-state-000000000000'))
  const serialized = JSON.stringify(resolved)
  assert.doesNotMatch(serialized, /\$\{[^}]+\}/, 'resolved managed policy must not retain CloudFormation placeholders')
  return serialized
}

test('bootstrap trusts only the existing account OIDC provider and reviewed GitHub environment', () => {
  assert.match(bootstrap, /AllowedValues:\n\s+- arn:aws:iam::167217327520:oidc-provider\/token\.actions\.githubusercontent\.com/)
  assert.match(bootstrap, /token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com/)
  // GitHub issues an immutable subject claim for this repository, so the trust
  // policy pins both exact forms. Neither may be a wildcard.
  assert.match(bootstrap, /token\.actions\.githubusercontent\.com:sub:\n\s+- repo:stokd-cloud\/agent:environment:agent-validation\n\s+- repo:stokd-cloud@264210261\/agent@1354224769:environment:agent-validation/)
  assert.doesNotMatch(bootstrap, /githubusercontent\.com:sub:[^\n]*\*/, 'the OIDC subject must never be a wildcard')
  assert.doesNotMatch(bootstrap, /AWS::IAM::(?:User|AccessKey)|arn:aws:iam::167217327520:root/)
})

test('deploy role is boundary constrained and cannot mutate itself or unbounded roles', () => {
  assert.match(bootstrap, /AgentValidationDeployRole:[\s\S]*PermissionsBoundary: !Ref AgentDeployPermissionsBoundary/)
  assert.match(bootstrap, /ManagedPolicyArns:\n\s+- !Ref AgentDeployFoundationPolicy\n\s+- !Ref AgentDeployRuntimePolicy\n\s+- !Ref AgentDeployCustodyPolicy\n\s+- !Ref AgentDeployControlPolicy\n\s+- !Ref AgentDeploySstHomePolicy/)
  assert.doesNotMatch(bootstrap, /ManagedPolicyArns:\n\s+- !Ref AgentDeployPermissionsBoundary/)
  assert.equal(bootstrapValue.Resources.AgentValidationDeployRole.Properties.Policies, undefined, 'deploy role must have zero inline policies')
  const create = statement('CreateOnlyBoundedWorkloadRoles')
  assert.match(create, /arn:aws:iam::167217327520:role\/stokd-agent-workload-\*/)
  assert.match(create, /iam:PermissionsBoundary: arn:aws:iam::167217327520:policy\/stokd-agent-workload-boundary/)
  const manage = statement('ManageOnlyBoundedWorkloadRoles')
  assert.match(manage, /iam:PutRolePolicy/)
  assert.match(manage, /role\/stokd-agent-workload-\*/)
  assert.doesNotMatch(`${create}\n${manage}`, /stokd-agent-validation-deploy/)
  const pass = statement('PassOnlyBoundedWorkloadRoles')
  assert.match(pass, /iam:PassedToService:/)
  assert.match(pass, /ec2\.amazonaws\.com/)
  assert.match(pass, /ecs-tasks\.amazonaws\.com/)
  assert.match(pass, /events\.amazonaws\.com/)
  assert.doesNotMatch(pass, /lambda\.amazonaws\.com/)
})

test('exact attached-policy denials preserve retained custody and deploy-role immutability', () => {
  assert.deepEqual(policyStatement('AgentDeployControlPolicy', 'PersistentDeletionIsImpossible'), {
    Sid: 'PersistentDeletionIsImpossible',
    Effect: 'Deny',
    Action: [
      'ec2:DeleteVolume',
      'ecs:ExecuteCommand',
      'ecs:RunTask',
      'ecs:StartTask',
      'events:*',
      'kms:DisableKey',
      'kms:ScheduleKeyDeletion',
      's3:DeleteBucket',
      's3:DeleteObject',
      's3:DeleteObjectVersion',
      'secretsmanager:DeleteSecret',
    ],
    Resource: [
      'arn:aws:ec2:us-east-1:167217327520:volume/*',
      'arn:aws:ecs:us-east-1:167217327520:*',
      'arn:aws:events:us-east-1:167217327520:*',
      'arn:aws:kms:us-east-1:167217327520:key/*',
      'arn:aws:s3:::stokd-agent-*',
      'arn:aws:s3:::stokd-agent-*/*',
      'arn:aws:secretsmanager:us-east-1:167217327520:secret:stokd-agent-*',
    ],
  })
  assert.deepEqual(policyStatement('AgentDeployRuntimePolicy', 'CannotResetVolumeInitializationProof'), {
    Sid: 'CannotResetVolumeInitializationProof',
    Effect: 'Deny',
    Action: ['ec2:CreateTags', 'ec2:DeleteTags'],
    Resource: 'arn:aws:ec2:us-east-1:167217327520:volume/*',
    Condition: {
      Null: { 'ec2:CreateAction': 'true' },
      'ForAnyValue:StringEquals': { 'aws:TagKeys': ['InitializationState'] },
    },
  })
  assert.deepEqual(policyStatement('AgentDeployControlPolicy', 'CannotMutateBootstrapCustody'), {
    Sid: 'CannotMutateBootstrapCustody',
    Effect: 'Deny',
    Action: [
      'cloudformation:CreateChangeSet',
      'cloudformation:CreateStack',
      'cloudformation:ExecuteChangeSet',
      'cloudformation:UpdateStack',
    ],
    Resource: 'arn:aws:cloudformation:us-east-1:167217327520:stack/stokd-agent-bootstrap/*',
  })

  const attachedPolicyIds = bootstrapValue.Resources.AgentValidationDeployRole.Properties.ManagedPolicyArns
  const attachedStatements = attachedPolicyIds.flatMap(logicalId =>
    bootstrapValue.Resources[logicalId].Properties.PolicyDocument.Statement)
  const attachedIamActions = attachedStatements
    .filter(value => value.Effect === 'Allow')
    .flatMap(value => [value.Action].flat())
    .filter(action => action.startsWith('iam:'))
  for (const action of attachedIamActions) {
    assert.doesNotMatch(action, /[*?]/, 'attached deploy-role IAM actions must remain explicit')
  }
  for (const forbidden of [
    'iam:AttachRolePolicy',
    'iam:CreatePolicy',
    'iam:CreatePolicyVersion',
    'iam:DeletePolicy',
    'iam:DeletePolicyVersion',
    'iam:DetachRolePolicy',
    'iam:SetDefaultPolicyVersion',
    'iam:UpdateAssumeRolePolicy',
  ]) {
    assert(!attachedIamActions.includes(forbidden), `deploy role must not receive ${forbidden}`)
  }
  for (const sid of ['CreateOnlyBoundedWorkloadRoles', 'ManageOnlyBoundedWorkloadRoles', 'PassOnlyBoundedWorkloadRoles']) {
    assert.equal(
      policyStatement('AgentDeployControlPolicy', sid).Resource,
      'arn:aws:iam::167217327520:role/stokd-agent-workload-*',
      `${sid} must remain unable to target the deploy role`,
    )
  }
  assert.equal(bootstrapValue.Resources.AgentValidationDeployRole.Properties.Policies, undefined)
})

test('every managed policy remains within the IAM 6,144-character document limit', () => {
  const managedPolicies = Object.entries(bootstrapValue.Resources)
    .filter(([, resource]) => resource.Type === 'AWS::IAM::ManagedPolicy')
  assert(managedPolicies.length >= 7, 'bootstrap managed-policy inventory changed')
  for (const [logicalId, resource] of managedPolicies) {
    const length = resolvePolicyDocument(resource.Properties.PolicyDocument).replace(/\s/g, '').length
    assert(length <= 6_144, `${logicalId} resolved policy document is ${length} characters`)
  }
})

test('SST home listing includes the exact app prefixes used by pinned ListStages', () => {
  const statements = bootstrapValue.Resources.AgentDeploySstHomePolicy.Properties.PolicyDocument.Statement
  const stateBucket = 'sst-state-000000000000'
  assert.doesNotThrow(() => assertExactSstHomePolicy(
    JSON.parse(resolvePolicyDocument(bootstrapValue.Resources.AgentDeploySstHomePolicy.Properties.PolicyDocument)),
    stateBucket,
  ))
  const boundaryDocument = JSON.parse(resolvePolicyDocument(bootstrapValue.Resources.AgentDeployPermissionsBoundary.Properties.PolicyDocument))
  const boundaryMetadata = boundaryDocument.Statement.filter(value => value.Resource === `arn:aws:s3:::${stateBucket}` && [value.Action].flat().includes('s3:GetBucketPolicy'))
  assert.equal(boundaryMetadata.length, 1, 'deploy boundary must have one exact SST state metadata statement')
  assert.deepEqual(boundaryMetadata[0].Action, [
    's3:GetBucketPolicy',
    's3:GetBucketPublicAccessBlock',
    's3:GetBucketLocation',
    's3:GetBucketOwnershipControls',
    's3:GetBucketVersioning',
    's3:GetEncryptionConfiguration',
    's3:GetLifecycleConfiguration',
  ])
  const listing = statements.find(value => value.Sid === 'ExactSstStatePrefixes')
  assert(listing, 'SST home policy omitted its prefix-bounded listing statement')
  const prefixes = listing.Condition.StringLike['s3:prefix']
  assert(prefixes.includes('app/stokd-agent-data'))
  assert(prefixes.includes('app/stokd-agent-api'))
  assert(prefixes.includes('app/stokd-agent-data/*'))
  assert(prefixes.includes('app/stokd-agent-api/*'))
})

test('routine deployment cannot read managed secrets or delete retained custody resources', () => {
  const secrets = statement('AgentGeneratedSecretsWithoutDeletion')
  assert.doesNotMatch(secrets, /GetSecretValue|PutSecretValue|PutResourcePolicy|DeleteSecret/)
  const buckets = statement('AgentBucketsWithoutDestruction')
  assert.match(buckets, /s3:GetLifecycleConfiguration/)
  assert.match(buckets, /s3:PutLifecycleConfiguration/)
  assert.doesNotMatch(buckets, /GetBucketLifecycleConfiguration|PutBucketLifecycleConfiguration|DeleteBucket|DeleteObject|s3:GetObject|s3:PutObject/)
  const evidence = statement('Work12ValidationEvidenceObjectsOnly')
  for (const action of ['s3:GetObject', 's3:GetObjectTagging', 's3:GetObjectVersion', 's3:PutObject', 's3:PutObjectTagging']) assert.match(evidence, new RegExp(action.replace(':', '\\:')))
  assert.match(evidence, /arn:aws:s3:::stokd-agent-artifacts-source-val12-167217327520\/validation\/work-1\.2\/source-val12\/\*/)
  assert.match(evidence, /arn:aws:s3:::stokd-agent-artifacts-restore-val12-167217327520\/validation\/work-1\.2\/restore-val12\/\*/)
  assert.doesNotMatch(evidence, /artifacts-\*-167217327520|backups-|Lifecycle|BucketPolicy|Delete/)
  const denial = statement('PersistentDeletionIsImpossible')
  for (const action of ['ec2:DeleteVolume', 'kms:DisableKey', 'kms:ScheduleKeyDeletion', 's3:DeleteBucket', 's3:DeleteObjectVersion', 'secretsmanager:DeleteSecret']) {
    assert.match(denial, new RegExp(action.replace(':', '\\:')))
  }
  // A blanket `s3:*` GRANT is the hazard. `s3:*` inside a Deny is strictly
  // protective — enumerating actions there would be weaker, because a future
  // S3 action would escape the deny. So require every `s3:*` to sit in a
  // Deny-effect statement rather than forbidding the string outright.
  for (const block of bootstrap.split(/(?=^\s*-?\s*Sid:)/m)) {
    if (!/Action:\s*['"]?s3:\*|\n\s+- s3:\*/.test(block)) continue
    assert.match(block, /Effect:\s*Deny/, `s3:* must only ever appear in a Deny statement, found: ${block.slice(0, 120)}`)
  }
})

test('validation evidence KMS use is S3-scoped and service roles cannot invoke cloud models', () => {
  const generic = statement('UseAgentKmsThroughExactAwsServices')
  for (const service of ['ec2.us-east-1.amazonaws.com', 'secretsmanager.us-east-1.amazonaws.com']) assert.match(generic, new RegExp(service.replaceAll('.', '\\.')))
  assert.doesNotMatch(generic, /s3\.us-east-1\.amazonaws\.com|bedrock|sagemaker|lambda|execute-api|kms:ViaService:\s*['"]?\*/i)
  const evidence = statement('Work12ValidationEvidenceKmsOnly')
  assert.match(evidence, /kms:ViaService: s3\.us-east-1\.amazonaws\.com/)
  for (const stage of ['source-val12', 'restore-val12']) assert.match(evidence, new RegExp(`arn:aws:s3:::stokd-agent-artifacts-${stage}-167217327520/validation/work-1\\.2/${stage}/\\*`))
  assert.match(dataInfrastructure, /Sid: 'BoundedDeployServiceUse'[\s\S]*'kms:ViaService': \[`ec2\.\$\{AGENT_AWS_REGION\}\.amazonaws\.com`, `secretsmanager\.\$\{AGENT_AWS_REGION\}\.amazonaws\.com`\]/)
  assert.match(dataInfrastructure, /Sid: 'BoundedDeployEvidenceS3Use'[\s\S]*'kms:ViaService': `s3\.\$\{AGENT_AWS_REGION\}\.amazonaws\.com`[\s\S]*'kms:EncryptionContext:aws:s3:arn'/)
  assert.match(read('scripts/infra-evidence.mjs'), /--no-bucket-key-enabled/)
  assert.doesNotMatch(`${bootstrap}\n${dataInfrastructure}\n${apiInfrastructure}`, /bedrock:(?:InvokeModel|InvokeModelWithResponseStream)|sagemaker:InvokeEndpoint/i)
})

test('refresh permissions include the exact DNS zone reads and certificate tag reads', () => {
  assert.match(statement('IdentityAndReadback'), /route53:ListResourceRecordSets/)
  assert.match(statement('IdentityAndReadback'), /acm:ListTagsForCertificate/)
  assert.match(statement('ExactDnsZoneOnly'), /hostedzone\/Z0974146XEXJDMNXU573/)
})

test('branch-native validation is exact-branch, environment-reviewed, and dispatch-safe', () => {
  assert.match(workflow, /branches: \[project\/d7f02e6-cloud-agents-mvp]/)
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/project\/d7f02e6-cloud-agents-mvp'/)
  assert.match(workflow, /environment: agent-validation/)
  assert.match(workflow, /id-token: write/)
  assert.match(workflow, /action: \$\{\{ steps\.select\.outputs\.action }}/)
  assert.match(workflow, /component: \$\{\{ steps\.select\.outputs\.component }}/)
  assert.match(workflow, /phase: \$\{\{ steps\.select\.outputs\.phase }}/)
  assert.match(workflow, /scenario: \$\{\{ steps\.select\.outputs\.scenario }}/)
  assert.doesNotMatch(workflow, /branches:\s*\[(?:main|master|\*)]/)
  const environment = {
    name: 'agent-validation',
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 91224556, login: 'brian-stoker' } }] }],
  }
  const policies = { branch_policies: [{ name: 'project/d7f02e6-cloud-agents-mvp', type: 'branch' }] }
  assert.doesNotThrow(() => assertGitHubEnvironment(environment, policies))
  assert.throws(() => assertGitHubEnvironment(environment, { branch_policies: [...policies.branch_policies, { name: 'main', type: 'branch' }] }), /allow only/)
  assert.match(read('scripts/infra-bootstrap.mjs'), /infra-github-environment\.mjs.*verify/s)
})

test('GitHub environment apply is create-only and refuses to overwrite existing controls', () => {
  const exactEnvironment = {
    name: 'agent-validation',
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 91224556, login: 'brian-stoker' } }] }],
  }
  const exactPolicies = { branch_policies: [{ name: 'project/d7f02e6-cloud-agents-mvp', type: 'branch' }] }
  const mutations = []
  assert.deepEqual(ensureGitHubEnvironment({
    getEnvironment: () => exactEnvironment,
    getPolicies: () => exactPolicies,
    createEnvironment: value => mutations.push(['environment', value]),
    configureEnvironment: value => mutations.push(['configuration', value]),
    createBranchPolicy: value => mutations.push(['policy', value]),
  }), { created: false, mutated: false })
  assert.deepEqual(mutations, [])

  const mismatched = { ...exactEnvironment, deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }
  assert.throws(() => ensureGitHubEnvironment({
    getEnvironment: () => mismatched,
    getPolicies: () => exactPolicies,
    createEnvironment: value => mutations.push(['environment', value]),
    configureEnvironment: value => mutations.push(['configuration', value]),
    createBranchPolicy: value => mutations.push(['policy', value]),
  }), /custom deployment branch policies only/)
  assert.deepEqual(mutations, [])

  let environment
  let policies = { branch_policies: [] }
  const createdMutations = []
  assert.deepEqual(ensureGitHubEnvironment({
    getEnvironment: () => environment,
    getPolicies: () => policies,
    createEnvironment: () => {
      createdMutations.push(['environment'])
      environment = { name: 'agent-validation', deployment_branch_policy: null, protection_rules: [] }
    },
    configureEnvironment: value => {
      createdMutations.push(['configuration', value])
      environment = exactEnvironment
    },
    createBranchPolicy: value => {
      createdMutations.push(['policy', value])
      policies = exactPolicies
    },
  }), { created: true, mutated: true })
  assert.deepEqual(createdMutations.map(([kind]) => kind), ['environment', 'configuration', 'policy'])
  const source = read('scripts/infra-github-environment.mjs')
  assert.doesNotMatch(source, /--method', 'DELETE'/)
  assert.match(source, /createEnvironment\(input:/)
  assert.doesNotMatch(source, /If-None-Match/)
})

test('Mongo initialization is loopback-only and steady state has no recovery administrator', () => {
  assert.match(mongoEntrypoint, /--bind_ip 127\.0\.0\.1/)
  assert.match(mongoEntrypoint, /initialization_port != 27017/)
  assert.match(mongoEntrypoint, /--auth \\\n+  --keyFile/)
  assert.match(mongoEntrypoint, /agent_runtime/)
  assert.match(mongoEntrypoint, /agent_migration/)
  assert.match(mongoEntrypoint, /agent_backup/)
  assert.doesNotMatch(mongoEntrypoint, /agent_restore|agent_bootstrap|anyAction|anyResource|userAdminAnyDatabase|--password/)
})

test('immutable image reuse requires exact source and Docker-context provenance', () => {
  const expected = expectedImageProvenance({
    component: 'api', dockerfile: 'infra/docker/api.Dockerfile', dockerfileDigest: 'd'.repeat(64),
    sourceDigest: 'a'.repeat(40), sourceTree: 'b'.repeat(40), stage: 'source-val12',
  })
  assert.doesNotThrow(() => assertImageProvenance({ ...expected, extra: 'allowed' }, expected, 'api'))
  assert.throws(() => assertImageProvenance({ ...expected, 'io.stokd.agent.context-tree': 'c'.repeat(40) }, expected, 'api'), /provenance mismatch/)
  assert.match(imagePublisher, /describeExistingImage\(tagName\)/)
  assert.match(imagePublisher, /--provenance=true/)
  assert.match(imagePublisher, /--sbom=true/)
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  SST_BOOTSTRAP_PARAMETER,
  SST_HOME_IDENTITIES,
  SST_PASSPHRASE_IDENTITIES,
  assertAwsManagedSsmKms,
  assertSstAssetEcr,
  assertSstPassphraseMetadata,
  assertSstStateBucketControls,
  assertSstStateBucketOwnership,
  assertSstStateBucketPolicy,
  assertSstStateLifecycle,
  assertUsEast1BucketLocation,
  parseSstBootstrapParameter,
  sstPassphraseParameter,
} from './infra-sst-bootstrap.mjs'
import { inspectCompletedSstInitialization } from './infra-initialize-sst-home.mjs'

const accountId = '167217327520'
const region = 'us-east-1'
const expectedEndpointServices = [
  'ec2', 'ec2messages', 'ecr.api', 'ecr.dkr', 'ecs', 'ecs-agent', 'ecs-telemetry',
  'kms', 'logs', 's3', 'secretsmanager', 'ssm', 'ssmmessages',
].map(name => `com.amazonaws.${region}.${name}`).sort()
const forbiddenExecutorFamilies = [
  'lambda:Invoke*', 'states:Start*', 'ecs:RunTask', 'ecs:StartTask', 'ecs:ExecuteCommand', 'batch:SubmitJob',
  'events:PutEvents', 'sns:Publish', 'sqs:SendMessage',
]
const forbiddenModelFamilies = ['bedrock:*', 'sagemaker:InvokeEndpoint*']
const forbiddenModelAction = /^(?:bedrock:|sagemaker:InvokeEndpoint)/i
const expectedHostDocuments = {
  'stokd-agent-migrate-host-v1': {
    schemaVersion: '2.2', description: 'Invoke only the installed, ownership-guarded Agent migration controller',
    parameters: {
      OperationId: { type: 'String', allowedPattern: '^[a-z0-9][a-z0-9-]{2,80}$' },
      TargetStage: { type: 'String', allowedValues: ['source-val12', 'restore-val12'] },
    },
    mainSteps: [{ action: 'aws:runShellScript', name: 'InvokeGuardedMigrationHost', inputs: { timeoutSeconds: '1800', runCommand: ["/opt/stokd-agent/bin/migrate-host --operation-id '{{ OperationId }}' --target-stage '{{ TargetStage }}'"] } }],
  },
  'stokd-agent-validation-seed-v1': {
    schemaVersion: '2.2', description: 'Seed the fixed source-stage durability fixture without dispatching work',
    mainSteps: [{ action: 'aws:runShellScript', name: 'InvokeFixedValidationSeed', inputs: { timeoutSeconds: '900', runCommand: ['/opt/stokd-agent/bin/validation-seed-host'] } }],
  },
  'stokd-agent-validation-backup-v1': {
    schemaVersion: '2.2', description: 'Create the fixed source-stage quiesced backup and custody receipt',
    mainSteps: [{ action: 'aws:runShellScript', name: 'InvokeFixedValidationBackup', inputs: { timeoutSeconds: '7200', runCommand: ['/opt/stokd-agent/bin/backup-host'] } }],
  },
  'stokd-agent-restore-host-v1': {
    schemaVersion: '2.2', description: 'Invoke only the installed, ownership-guarded Agent restore host controller',
    parameters: {
      OperationId: { type: 'String', allowedPattern: '^[a-z0-9][a-z0-9-]{2,80}$' },
      ManifestKey: { type: 'String', allowedPattern: '^[A-Za-z0-9][A-Za-z0-9._/-]{0,512}$' },
      ManifestVersionId: { type: 'String', allowedPattern: '^[A-Za-z0-9._=+/-]{1,1000}$' },
      ManifestSha256: { type: 'String', allowedPattern: '^[a-f0-9]{64}$' },
      ArchiveKey: { type: 'String', allowedPattern: '^[A-Za-z0-9][A-Za-z0-9._/-]{0,512}$' },
      ArchiveVersionId: { type: 'String', allowedPattern: '^[A-Za-z0-9._=+/-]{1,1000}$' },
      ArchiveSha256: { type: 'String', allowedPattern: '^[a-f0-9]{64}$' },
    },
    mainSteps: [{ action: 'aws:runShellScript', name: 'InvokeGuardedRestoreHost', inputs: {
      timeoutSeconds: '7200',
      runCommand: ["/opt/stokd-agent/bin/restore-host --operation-id '{{ OperationId }}' --source-bucket 'stokd-agent-backups-source-val12-167217327520' --manifest-key '{{ ManifestKey }}' --manifest-version-id '{{ ManifestVersionId }}' --manifest-sha256 '{{ ManifestSha256 }}' --archive-key '{{ ArchiveKey }}' --archive-version-id '{{ ArchiveVersionId }}' --archive-sha256 '{{ ArchiveSha256 }}' --target-stage 'restore-val12'"],
    } }],
  },
}

function json(raw, label) {
  try { return JSON.parse(raw) }
  catch { throw new Error(`${label} returned invalid JSON`) }
}
function one(values, label) {
  assert(Array.isArray(values) && values.length === 1, `${label} must resolve exactly once`)
  return values[0]
}
// AWS is not consistent about tag shape: EC2 and S3 return Key/Value, KMS
// returns TagKey/TagValue. Reading only the first shape silently produced an
// empty tag set for every KMS assertion.
function tags(values) { return Object.fromEntries((values ?? []).map(tag => [tag.Key ?? tag.TagKey ?? tag.key, tag.Value ?? tag.TagValue ?? tag.value])) }
function assertTags(value, stage, label) {
  const actual = tags(value)
  assert.equal(actual.Project, 'stokd-agent', `${label} Project tag changed`)
  assert.equal(actual.Stage, stage, `${label} Stage tag changed`)
}
function policyDocument(value, label) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string') {
    for (const candidate of [value, (() => { try { return decodeURIComponent(value) } catch { return '' } })()]) {
      try { return JSON.parse(candidate) } catch {}
    }
  }
  throw new Error(`${label} policy document is invalid`)
}
function policyStatements(document, label) {
  const parsed = policyDocument(document, label)
  const statements = Array.isArray(parsed.Statement) ? parsed.Statement : [parsed.Statement].filter(Boolean)
  assert(statements.length > 0, `${label} policy has no statements`)
  return statements
}
function values(value) { return Array.isArray(value) ? value : [value].filter(item => item !== undefined) }
export function exactStageSecretArns(secrets, stage, label = `${stage} secrets`) {
  assert(secrets && typeof secrets === 'object' && !Array.isArray(secrets), `${label} must be an object`)
  assert.deepEqual(Object.keys(secrets).sort(), ['backupArn', 'migrationArn', 'runtimeArn'], `${label} fields changed`)
  return ['runtime', 'migration', 'backup'].map(kind => {
    const arn = secrets[`${kind}Arn`]
    assert.match(arn ?? '', new RegExp(`^arn:aws:secretsmanager:${region}:${accountId}:secret:stokd-agent-${stage}-${kind}-[A-Za-z0-9]{6}$`), `${label} ${kind} ARN changed`)
    return arn
  })
}
function actionPatternMatches(pattern, action) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')
  return new RegExp(`^${escaped}$`, 'i').test(action)
}
function analyzePolicy(document, label) {
  const allow = []
  const deny = []
  const allowStatements = []
  const denyStatements = []
  for (const statement of policyStatements(document, label)) {
    if (statement.NotAction !== undefined) throw new Error(`${label} uses NotAction and cannot prove bounded execution`)
    const actions = values(statement.Action).map(String)
    if (statement.Effect === 'Allow') {
      assert.equal(actions.includes('*'), false, `${label} has a global wildcard Allow`)
      allow.push(...actions)
      allowStatements.push(statement)
    } else if (statement.Effect === 'Deny') {
      deny.push(...actions)
      denyStatements.push(statement)
    }
  }
  return { allow, deny, allowStatements, denyStatements }
}
function policyAllows(actions, target) { return actions.some(pattern => actionPatternMatches(pattern, target)) }
function actionPatternsOverlap(left, right) {
  const a = String(left).toLowerCase()
  const b = String(right).toLowerCase()
  const alphabet = [...new Set([...a, ...b].filter(value => value !== '*' && value !== '?'))]
  alphabet.push('\u0000')
  const queue = [[0, 0]]
  const seen = new Set()
  while (queue.length > 0) {
    const [ai, bi] = queue.shift()
    const key = `${ai}:${bi}`
    if (seen.has(key)) continue
    seen.add(key)
    if (ai === a.length && bi === b.length) return true
    if (a[ai] === '*') queue.push([ai + 1, bi])
    if (b[bi] === '*') queue.push([ai, bi + 1])
    for (const character of alphabet) {
      const nextA = ai < a.length && (a[ai] === '*' || a[ai] === '?' || a[ai] === character) ? (a[ai] === '*' ? ai : ai + 1) : -1
      const nextB = bi < b.length && (b[bi] === '*' || b[bi] === '?' || b[bi] === character) ? (b[bi] === '*' ? bi : bi + 1) : -1
      if (nextA >= 0 && nextB >= 0 && (nextA !== ai || nextB !== bi)) queue.push([nextA, nextB])
    }
  }
  return false
}
function unconditionalGlobalDeny(statement) {
  return statement.Effect === 'Deny' && statement.Condition === undefined && statement.NotResource === undefined && values(statement.Resource).includes('*')
}
function deniedEverywhere(policies, action) {
  return policies.some(policy => policy.analysis.denyStatements.some(statement => unconditionalGlobalDeny(statement) && values(statement.Action).some(pattern => actionPatternMatches(pattern, action))))
}
function familyDeniedEverywhere(policies, family) {
  return policies.some(policy => policy.analysis.denyStatements.some(statement => unconditionalGlobalDeny(statement) && values(statement.Action).some(pattern => {
    const normalized = String(pattern).toLowerCase()
    return normalized === '*' || normalized === family.toLowerCase() || normalized === `${family.split(':')[0].toLowerCase()}:*`
  })))
}
function assertNoEffectiveExecutor(identityPolicies, boundaryPolicy, roleName) {
  const identityAllow = identityPolicies.flatMap(value => value.analysis.allow)
  const allPolicies = [...identityPolicies, boundaryPolicy]
  for (const family of forbiddenExecutorFamilies) {
    const identityPatterns = identityAllow.filter(pattern => actionPatternsOverlap(pattern, family))
    const boundaryPatterns = boundaryPolicy.analysis.allow.filter(pattern => actionPatternsOverlap(pattern, family))
    const effective = identityPatterns.some(identityPattern => boundaryPatterns.some(boundaryPattern => actionPatternsOverlap(identityPattern, boundaryPattern))) &&
      !familyDeniedEverywhere(allPolicies, family)
    assert.equal(effective, false, `${roleName} can effectively invoke ${family}`)
  }
  for (const family of forbiddenModelFamilies) {
    const identityPatterns = identityAllow.filter(pattern => actionPatternsOverlap(pattern, family))
    const boundaryPatterns = boundaryPolicy.analysis.allow.filter(pattern => actionPatternsOverlap(pattern, family))
    const effective = identityPatterns.some(identityPattern => boundaryPatterns.some(boundaryPattern => actionPatternsOverlap(identityPattern, boundaryPattern))) &&
      !familyDeniedEverywhere(allPolicies, family)
    assert.equal(effective, false, `${roleName} can effectively invoke ${family}`)
  }
}
export function assertNoEffectiveModelOrExecutor({ identityPolicies, boundaryPolicy, roleName = 'fixture-role' }) {
  const identities = identityPolicies.map((document, index) => ({ analysis: analyzePolicy(document, `${roleName} identity ${index + 1}`) }))
  const boundary = { analysis: analyzePolicy(boundaryPolicy, `${roleName} boundary`) }
  assertNoEffectiveExecutor(identities, boundary, roleName)
  return { modelInvokeAllowed: false, hiddenExecutorAllowed: false }
}
function ruleSources(permission) {
  return [
    ...(permission.IpRanges ?? []).map(value => `ipv4:${value.CidrIp}`),
    ...(permission.Ipv6Ranges ?? []).map(value => `ipv6:${value.CidrIpv6}`),
    ...(permission.UserIdGroupPairs ?? []).map(value => `sg:${value.GroupId}`),
    ...(permission.PrefixListIds ?? []).map(value => `prefix:${value.PrefixListId}`),
  ]
}
function permissionSignatures(permissions) {
  return (permissions ?? []).flatMap(permission => ruleSources(permission).map(source => `${permission.IpProtocol}:${permission.FromPort ?? '*'}:${permission.ToPort ?? '*'}:${source}`)).sort()
}
function assertExactPermissions(group, expectedIngress, expectedEgress, label) {
  assert.deepEqual(permissionSignatures(group.IpPermissions), [...expectedIngress].sort(), `${label} ingress changed`)
  assert.deepEqual(permissionSignatures(group.IpPermissionsEgress), [...expectedEgress].sort(), `${label} egress changed`)
}

function managedPolicy(aws, arn, label) {
  const metadata = json(aws(['iam', 'get-policy', '--policy-arn', arn, '--output', 'json']), `${label} metadata`).Policy
  const version = json(aws(['iam', 'get-policy-version', '--policy-arn', arn, '--version-id', metadata.DefaultVersionId, '--output', 'json']), `${label} version`).PolicyVersion
  const document = policyDocument(version.Document, label)
  return { arn, versionId: metadata.DefaultVersionId, document, analysis: analyzePolicy(document, label) }
}
function rolePolicySet(aws, role) {
  const roleName = role.RoleName
  const inlineNames = json(aws(['iam', 'list-role-policies', '--role-name', roleName, '--output', 'json']), `${roleName} inline policies`).PolicyNames ?? []
  const inline = inlineNames.map(policyName => {
    const document = policyDocument(json(aws(['iam', 'get-role-policy', '--role-name', roleName, '--policy-name', policyName, '--output', 'json']), `${roleName}/${policyName}`).PolicyDocument, `${roleName}/${policyName}`)
    return { name: policyName, document, analysis: analyzePolicy(document, `${roleName}/${policyName}`) }
  })
  const attached = (json(aws(['iam', 'list-attached-role-policies', '--role-name', roleName, '--output', 'json']), `${roleName} attached policies`).AttachedPolicies ?? [])
    .map(value => managedPolicy(aws, value.PolicyArn, `${roleName}/${value.PolicyName}`))
  const boundaryArn = role.PermissionsBoundary?.PermissionsBoundaryArn
  assert(boundaryArn, `${roleName} omitted its permissions boundary`)
  const boundary = managedPolicy(aws, boundaryArn, `${roleName} boundary`)
  assertNoEffectiveExecutor([...inline, ...attached], boundary, roleName)
  return { inline, attached, boundary }
}

export function assertExactServiceTrust(document, roleName, principalService) {
  const statements = policyStatements(document, `${roleName} trust`)
  assert.equal(statements.length, 1, `${roleName} trust must have one statement`)
  const statement = statements[0]
  assert.equal(statement.Effect, 'Allow')
  assert.deepEqual(values(statement.Action), ['sts:AssumeRole'])
  assert.deepEqual(Object.keys(statement.Principal ?? {}), ['Service'])
  assert.deepEqual(values(statement.Principal.Service), [principalService])
  assert.equal(statement.Condition, undefined)
}
function effectiveSecretReadResources(policies) {
  if (!policyAllows(policies.boundary.analysis.allow, 'secretsmanager:GetSecretValue') || deniedEverywhere([policies.boundary], 'secretsmanager:GetSecretValue')) return []
  return [...new Set([...policies.inline, ...policies.attached].flatMap(policy => policy.analysis.allowStatements)
    .filter(statement => values(statement.Action).some(pattern => actionPatternMatches(pattern, 'secretsmanager:GetSecretValue')))
    .flatMap(statement => {
      assert.equal(statement.NotResource, undefined, 'secret-read authority uses NotResource')
      return values(statement.Resource).map(String)
    }))].sort()
}
export function assertEffectiveSecretReadScope({ identityPolicies, boundaryPolicy, expectedResources, roleName = 'fixture-role' }) {
  const inline = identityPolicies.map((document, index) => ({ analysis: analyzePolicy(document, `${roleName} identity ${index + 1}`) }))
  const boundary = { analysis: analyzePolicy(boundaryPolicy, `${roleName} boundary`) }
  const actual = effectiveSecretReadResources({ inline, attached: [], boundary })
  assert.deepEqual(actual, [...expectedResources].sort(), `${roleName} effective secret-read scope changed`)
  return actual
}
function inspectRole(aws, roleName, principalService, stage, expectedSecretReadResources) {
  const role = json(aws(['iam', 'get-role', '--role-name', roleName, '--output', 'json']), `${roleName} role`).Role
  assert.equal(role.RoleName, roleName)
  assert.equal(role.PermissionsBoundary?.PermissionsBoundaryArn, `arn:aws:iam::${accountId}:policy/stokd-agent-workload-boundary`)
  assertTags(role.Tags, stage, `${roleName} role`)
  assertExactServiceTrust(policyDocument(role.AssumeRolePolicyDocument, `${roleName} trust`), roleName, principalService)
  const policies = rolePolicySet(aws, role)
  const allowedActions = [...policies.inline, ...policies.attached].flatMap(value => value.analysis.allow)
  const secretReadResources = effectiveSecretReadResources(policies)
  if (expectedSecretReadResources !== undefined) assert.deepEqual(secretReadResources, [...expectedSecretReadResources].sort(), `${roleName} effective secret-read scope changed`)
  return {
    roleName, arn: role.Arn, boundaryArn: policies.boundary.arn,
    inlinePolicies: policies.inline.map(value => value.name).sort(),
    attachedPolicies: policies.attached.map(value => value.arn).sort(),
    allowedActionCount: allowedActions.length, secretReadResources, modelInvokeAllowed: false,
  }
}

export function assertExactDeployTrust(document, roleName = 'stokd-agent-validation-deploy') {
  const statements = policyStatements(document, `${roleName} trust`)
  assert.equal(statements.length, 1, `${roleName} trust must have one statement`)
  const statement = statements[0]
  assert.equal(statement.Effect, 'Allow')
  assert.deepEqual(values(statement.Action), ['sts:AssumeRoleWithWebIdentity'])
  assert.deepEqual(Object.keys(statement.Principal ?? {}), ['Federated'])
  assert.equal(statement.Principal.Federated, `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`)
  assert.deepEqual(statement.Condition, { StringEquals: {
    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    'token.actions.githubusercontent.com:sub': ['repo:stokd-cloud/agent:environment:agent-validation', 'repo:stokd-cloud@264210261/agent@1354224769:environment:agent-validation'],
  } })
}

export function assertExactSendCommandScope(identityPolicies, roleName = 'stokd-agent-validation-deploy') {
  const statements = identityPolicies.flatMap((document, index) => policyStatements(document, `${roleName} identity ${index + 1}`))
    .filter(statement => statement.Effect === 'Allow' && values(statement.Action).some(pattern => actionPatternMatches(pattern, 'ssm:SendCommand')))
  assert.equal(statements.length, 2, `${roleName} must have exactly two SendCommand resource halves`)
  const documentResources = [
    'arn:aws:ssm:us-east-1:167217327520:document/stokd-agent-migrate-host-v1',
    'arn:aws:ssm:us-east-1:167217327520:document/stokd-agent-validation-seed-v1',
    'arn:aws:ssm:us-east-1:167217327520:document/stokd-agent-validation-backup-v1',
    'arn:aws:ssm:us-east-1:167217327520:document/stokd-agent-restore-host-v1',
  ].sort()
  const documents = one(statements.filter(statement => values(statement.Resource).every(resource => String(resource).includes(':document/'))), `${roleName} SendCommand document scope`)
  assert.deepEqual(values(documents.Action), ['ssm:SendCommand'])
  assert.deepEqual(values(documents.Resource).map(String).sort(), documentResources)
  assert.equal(documents.Condition, undefined)
  assert.equal(documents.NotResource, undefined)
  const instances = one(statements.filter(statement => values(statement.Resource).every(resource => String(resource).includes(':instance/'))), `${roleName} SendCommand instance scope`)
  assert.deepEqual(values(instances.Action), ['ssm:SendCommand'])
  assert.deepEqual(values(instances.Resource), ['arn:aws:ec2:us-east-1:167217327520:instance/*'])
  assert.equal(instances.NotResource, undefined)
  assert.deepEqual(instances.Condition, {
    StringEquals: { 'ssm:resourceTag/Project': 'stokd-agent' },
    StringLike: { 'ssm:resourceTag/Stage': ['source-val12', 'restore-val12'] },
  })
}

export function assertExactDeployPolicySet({ inlinePolicyNames, attachedPolicyArns, boundaryArn }, roleName = 'stokd-agent-validation-deploy') {
  assert.deepEqual(inlinePolicyNames, [], `${roleName} must have zero inline policies`)
  const expectedAttached = ['foundation', 'runtime', 'custody', 'control', 'sst-home']
    .map(name => `arn:aws:iam::${accountId}:policy/stokd-agent-validation-deploy-${name}`).sort()
  assert.deepEqual([...attachedPolicyArns].sort(), expectedAttached, `${roleName} attached policy set changed`)
  assert.equal(boundaryArn, `arn:aws:iam::${accountId}:policy/stokd-agent-validation-deploy-boundary`, `${roleName} permissions boundary changed`)
}

export function assertExactDeployCustodyDenials({ controlPolicy, runtimePolicy }, roleName = 'stokd-agent-validation-deploy') {
  const exactStatement = (document, sid, label) => {
    const matches = policyStatements(document, label).filter(statement => statement.Sid === sid)
    return one(matches, `${roleName} ${sid} denial`)
  }
  assert.deepEqual(exactStatement(controlPolicy, 'PersistentDeletionIsImpossible', `${roleName} control policy`), {
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
  }, `${roleName} persistent-deletion denial changed`)
  assert.deepEqual(exactStatement(runtimePolicy, 'CannotResetVolumeInitializationProof', `${roleName} runtime policy`), {
    Sid: 'CannotResetVolumeInitializationProof',
    Effect: 'Deny',
    Action: ['ec2:CreateTags', 'ec2:DeleteTags'],
    Resource: 'arn:aws:ec2:us-east-1:167217327520:volume/*',
    Condition: {
      Null: { 'ec2:CreateAction': 'true' },
      'ForAnyValue:StringEquals': { 'aws:TagKeys': ['InitializationState'] },
    },
  }, `${roleName} volume-initialization denial changed`)
  assert.deepEqual(exactStatement(controlPolicy, 'CannotMutateBootstrapCustody', `${roleName} control policy`), {
    Sid: 'CannotMutateBootstrapCustody',
    Effect: 'Deny',
    Action: [
      'cloudformation:CreateChangeSet',
      'cloudformation:CreateStack',
      'cloudformation:ExecuteChangeSet',
      'cloudformation:UpdateStack',
    ],
    Resource: 'arn:aws:cloudformation:us-east-1:167217327520:stack/stokd-agent-validation-bootstrap/*',
  }, `${roleName} bootstrap-custody denial changed`)
  return ['CannotMutateBootstrapCustody', 'CannotResetVolumeInitializationProof', 'PersistentDeletionIsImpossible']
}

export function assertExactSstHomePolicy(document, stateBucket) {
  assert.match(stateBucket ?? '', /^sst-state-[a-z0-9]{12}$/)
  const bucketArn = `arn:aws:s3:::${stateBucket}`
  const identities = SST_HOME_IDENTITIES
  const passphrases = SST_PASSPHRASE_IDENTITIES.map(({ app, stage }) => `arn:aws:ssm:${region}:${accountId}:parameter/sst/passphrase/${app}/${stage}`)
  const appObjects = identities.map(({ app, stage }) => `${bucketArn}/app/${app}/${stage}.json`)
  const generatedObjects = ['update', 'snapshot', 'eventlog'].flatMap(kind => identities.map(({ app, stage }) => `${bucketArn}/${kind}/${app}/${stage}/*`))
  const lockObjects = identities.map(({ app, stage }) => `${bucketArn}/lock/${app}/${stage}.json`)
  const readOnly = [
    ...identities.map(({ app, stage }) => `${bucketArn}/secret/${app}/${stage}.json`),
    `${bucketArn}/secret/stokd-agent-data/_fallback.json`, `${bucketArn}/secret/stokd-agent-api/_fallback.json`,
    `${bucketArn}/bootstrap-init/work-1.2/*`,
  ]
  assert.deepEqual(policyDocument(document, 'SST home policy'), {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'ExactSstBootstrapRecord', Effect: 'Allow', Action: 'ssm:GetParameter', Resource: `arn:aws:ssm:${region}:${accountId}:parameter/sst/bootstrap` },
      { Sid: 'ExactSstPassphrases', Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:ListTagsForResource'], Resource: passphrases },
      { Sid: 'ExistingSstStateBucketMetadata', Effect: 'Allow', Action: ['s3:GetBucketPolicy', 's3:GetBucketPublicAccessBlock', 's3:GetBucketLocation', 's3:GetBucketOwnershipControls', 's3:GetBucketVersioning', 's3:GetEncryptionConfiguration', 's3:GetLifecycleConfiguration'], Resource: bucketArn },
      { Sid: 'ExactSstStatePrefixes', Effect: 'Allow', Action: ['s3:ListBucket', 's3:ListBucketVersions'], Resource: bucketArn, Condition: { StringLike: { 's3:prefix': [
        'app/stokd-agent-data', 'app/stokd-agent-api', 'app/stokd-agent-data/*', 'app/stokd-agent-api/*', 'lock/stokd-agent-data/*', 'lock/stokd-agent-api/*',
        'update/stokd-agent-data/*', 'update/stokd-agent-api/*', 'snapshot/stokd-agent-data/*', 'snapshot/stokd-agent-api/*',
        'eventlog/stokd-agent-data/*', 'eventlog/stokd-agent-api/*', 'secret/stokd-agent-data/*', 'secret/stokd-agent-api/*',
        'bootstrap-init/work-1.2/*',
      ] } } },
      { Sid: 'ExactMutableSstStateObjects', Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'], Resource: [...appObjects, ...generatedObjects] },
      { Sid: 'ExactSstLockObjects', Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject', 's3:DeleteObject'], Resource: lockObjects },
      { Sid: 'ReadOnlySstSecretAndInitObjects', Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: readOnly },
    ],
  }, 'SST home policy scope changed')
}

function inspectDeployRole(aws) {
  const roleName = 'stokd-agent-validation-deploy'
  const role = json(aws(['iam', 'get-role', '--role-name', roleName, '--output', 'json']), `${roleName} role`).Role
  assert.equal(role.PermissionsBoundary?.PermissionsBoundaryArn, `arn:aws:iam::${accountId}:policy/stokd-agent-validation-deploy-boundary`)
  const roleTags = tags(role.Tags)
  assert.equal(roleTags.Project, 'stokd-agent')
  assert.equal(roleTags.Custody, 'bootstrap')
  const trust = policyDocument(role.AssumeRolePolicyDocument, `${roleName} trust`)
  assertExactDeployTrust(trust, roleName)
  const policies = rolePolicySet(aws, role)
  assertExactDeployPolicySet({
    inlinePolicyNames: policies.inline.map(value => value.name),
    attachedPolicyArns: policies.attached.map(value => value.arn),
    boundaryArn: policies.boundary.arn,
  }, roleName)
  const sstBootstrap = parseSstBootstrapParameter(aws(['ssm', 'get-parameter', '--name', SST_BOOTSTRAP_PARAMETER, '--no-with-decryption', '--output', 'json']))
  const sstPolicy = one(policies.attached.filter(value => value.arn.endsWith('/stokd-agent-validation-deploy-sst-home')), `${roleName} SST home policy`)
  const controlPolicy = one(policies.attached.filter(value => value.arn.endsWith('/stokd-agent-validation-deploy-control')), `${roleName} control policy`)
  const runtimePolicy = one(policies.attached.filter(value => value.arn.endsWith('/stokd-agent-validation-deploy-runtime')), `${roleName} runtime policy`)
  assertExactSstHomePolicy(sstPolicy.document, sstBootstrap.state)
  const custodyDenials = assertExactDeployCustodyDenials({ controlPolicy: controlPolicy.document, runtimePolicy: runtimePolicy.document }, roleName)
  assertExactSendCommandScope([...policies.inline, ...policies.attached].map(value => value.document), roleName)
  const secretReadResources = effectiveSecretReadResources(policies)
  assert.deepEqual(secretReadResources, [], `${roleName} effective secret-read scope changed`)
  return {
    roleName, arn: role.Arn, boundaryArn: policies.boundary.arn,
    inlinePolicies: policies.inline.map(value => value.name).sort(),
    attachedPolicies: policies.attached.map(value => value.arn).sort(),
    custodyDenials,
    sstHomeStateBucket: sstBootstrap.state,
    allowedActionCount: [...policies.inline, ...policies.attached].flatMap(value => value.analysis.allow).length,
    secretReadResources, modelInvokeAllowed: false,
  }
}

function inspectBucket(aws, bucket, kmsKeyArn, stage) {
  const versioning = json(aws(['s3api', 'get-bucket-versioning', '--bucket', bucket, '--output', 'json']), `${bucket} versioning`)
  assert.equal(versioning.Status, 'Enabled')
  const encryption = json(aws(['s3api', 'get-bucket-encryption', '--bucket', bucket, '--output', 'json']), `${bucket} encryption`)
  const rule = one(encryption.ServerSideEncryptionConfiguration?.Rules, `${bucket} encryption rule`)
  assert.equal(rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm, 'aws:kms')
  assert.equal(rule.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID, kmsKeyArn)
  const block = json(aws(['s3api', 'get-public-access-block', '--bucket', bucket, '--output', 'json']), `${bucket} public block`).PublicAccessBlockConfiguration
  assert.deepEqual(block, { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true })
  const ownership = json(aws(['s3api', 'get-bucket-ownership-controls', '--bucket', bucket, '--output', 'json']), `${bucket} ownership`)
  assert.deepEqual(ownership.OwnershipControls?.Rules, [{ ObjectOwnership: 'BucketOwnerEnforced' }])
  assertTags(json(aws(['s3api', 'get-bucket-tagging', '--bucket', bucket, '--output', 'json']), `${bucket} tags`).TagSet, stage, `${bucket} bucket`)
  const lifecycle = json(aws(['s3api', 'get-bucket-lifecycle-configuration', '--bucket', bucket, '--output', 'json']), `${bucket} lifecycle`)
  assert((lifecycle.Rules ?? []).some(item => item.Status === 'Enabled' && item.NoncurrentVersionExpiration?.NoncurrentDays === 30 && item.AbortIncompleteMultipartUpload?.DaysAfterInitiation === 1), `${bucket} retention lifecycle changed`)
  const policyEnvelope = json(aws(['s3api', 'get-bucket-policy', '--bucket', bucket, '--output', 'json']), `${bucket} policy`)
  const policy = policyDocument(policyEnvelope.Policy, `${bucket} bucket`)
  const statements = policyStatements(policy, `${bucket} bucket`)
  assert.deepEqual(statements.map(value => value.Sid).sort(), ['DenyNonTls', 'DenyUnencryptedWrites', 'DenyWrongKey'])
  for (const statement of statements) assert.equal(statement.Effect, 'Deny', `${bucket}/${statement.Sid} stopped denying`)
  const wrongKey = statements.find(value => value.Sid === 'DenyWrongKey')
  assert.equal(wrongKey.Condition?.StringNotEquals?.['s3:x-amz-server-side-encryption-aws-kms-key-id'], kmsKeyArn)
  const unencrypted = statements.find(value => value.Sid === 'DenyUnencryptedWrites')
  assert.equal(unencrypted.Condition?.StringNotEquals?.['s3:x-amz-server-side-encryption'], 'aws:kms')
  return {
    bucket, versioning: 'Enabled', kmsKeyArn, bucketKeyEnabled: rule.BucketKeyEnabled === true,
    publicAccessBlocked: true, ownership: 'BucketOwnerEnforced',
    policySha256: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
  }
}

function inspectKms(aws, manifest) {
  const stage = manifest.stage
  const kmsKeyArn = manifest.custody.kmsKeyArn
  const key = json(aws(['kms', 'describe-key', '--key-id', kmsKeyArn, '--output', 'json']), 'KMS key').KeyMetadata
  assert.equal(key.Arn, kmsKeyArn)
  assert.equal(key.Enabled, true)
  assert.equal(key.KeyState, 'Enabled')
  assert.equal(key.KeyManager, 'CUSTOMER')
  assert.equal(key.KeyUsage, 'ENCRYPT_DECRYPT')
  assert.equal(json(aws(['kms', 'get-key-rotation-status', '--key-id', kmsKeyArn, '--output', 'json']), 'KMS rotation').KeyRotationEnabled, true)
  const alias = one(json(aws(['kms', 'list-aliases', '--key-id', key.KeyId, '--output', 'json']), 'KMS alias').Aliases.filter(value => value.AliasName === manifest.custody.kmsAliasName), 'KMS alias')
  assert.equal(alias.TargetKeyId, key.KeyId)
  assertTags(json(aws(['kms', 'list-resource-tags', '--key-id', kmsKeyArn, '--output', 'json']), 'KMS tags').Tags, stage, 'KMS key')
  const envelope = json(aws(['kms', 'get-key-policy', '--key-id', kmsKeyArn, '--policy-name', 'default', '--output', 'json']), 'KMS key policy')
  const policy = policyDocument(envelope.Policy, 'KMS key')
  const statements = policyStatements(policy, 'KMS key')
  const evidence = one(statements.filter(value => value.Sid === 'BoundedDeployEvidenceS3Use'), 'evidence KMS statement')
  assert.equal(evidence.Condition?.StringEquals?.['kms:ViaService'], `s3.${region}.amazonaws.com`)
  // S3 Bucket Keys present the BUCKET arn as the encryption context rather than
  // the object arn, so the policy must accept both forms. Object writes stay
  // scoped to the evidence prefix by the deploy role's own S3 statement.
  assert.deepEqual(
    [evidence.Condition?.StringLike?.['kms:EncryptionContext:aws:s3:arn']].flat().sort(),
    [
      `arn:aws:s3:::${manifest.custody.artifactBucket}`,
      `arn:aws:s3:::${manifest.custody.artifactBucket}/validation/work-1.2/${stage}/*`,
    ].sort(),
  )
  const general = one(statements.filter(value => value.Sid === 'BoundedDeployServiceUse'), 'general deploy KMS statement')
  assert.equal(values(general.Condition?.StringLike?.['kms:ViaService']).includes(`s3.${region}.amazonaws.com`), false)
  return {
    keyArn: kmsKeyArn, keyId: key.KeyId, aliasName: alias.AliasName, rotationEnabled: true,
    policySha256: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
  }
}

function inspectCloudMap(aws, manifest, networkInterface) {
  const namespace = json(aws(['servicediscovery', 'get-namespace', '--id', manifest.vpc.cloudmapNamespaceId, '--output', 'json']), 'Cloud Map namespace').Namespace
  assert.equal(namespace.Id, manifest.vpc.cloudmapNamespaceId)
  assert.equal(namespace.Name, manifest.vpc.cloudmapNamespaceName)
  assert.equal(namespace.Type, 'DNS_PRIVATE')
  const service = json(aws(['servicediscovery', 'get-service', '--id', manifest.mongo.discoveryServiceId, '--output', 'json']), 'Cloud Map service').Service
  assert.equal(service.Id, manifest.mongo.discoveryServiceId)
  assert.equal(service.NamespaceId, namespace.Id)
  assert.equal(service.Name, `mongo-${manifest.stage}`)
  const instance = json(aws(['servicediscovery', 'get-instance', '--service-id', service.Id, '--instance-id', manifest.mongo.discoveryInstanceId, '--output', 'json']), 'Cloud Map instance').Instance
  assert.equal(instance.Id, manifest.mongo.discoveryInstanceId)
  assert.equal(instance.Attributes?.AWS_INSTANCE_IPV4, networkInterface.PrivateIpAddress)
  return {
    namespace: { id: namespace.Id, arn: namespace.Arn, name: namespace.Name },
    service: { id: service.Id, arn: service.Arn, name: service.Name },
    instance: { id: instance.Id, serviceId: service.Id, privateIp: instance.Attributes.AWS_INSTANCE_IPV4 },
  }
}

function inspectEcsApi(aws, manifest) {
  const stage = manifest.stage
  const cluster = one(json(aws(['ecs', 'describe-clusters', '--clusters', manifest.cluster.arn, '--include', 'TAGS', '--output', 'json']), 'ECS cluster').clusters, 'ECS cluster')
  assert.equal(cluster.clusterArn, manifest.cluster.arn)
  assert.equal(cluster.clusterName, manifest.cluster.serviceName)
  assert.equal(cluster.status, 'ACTIVE')
  assert.deepEqual([...(cluster.capacityProviders ?? [])].sort(), ['FARGATE', 'FARGATE_SPOT'])
  assert.deepEqual(cluster.defaultCapacityProviderStrategy ?? [], [])
  assertTags(cluster.tags, stage, 'ECS cluster')
  const serviceResult = json(aws(['ecs', 'describe-services', '--cluster', manifest.cluster.arn, '--services', manifest.cluster.serviceArn, '--include', 'TAGS', '--output', 'json']), 'ECS service')
  assert.deepEqual(serviceResult.failures ?? [], [])
  const service = one(serviceResult.services, 'ECS service')
  assert.equal(service.serviceArn, manifest.cluster.serviceArn)
  assert.equal(service.serviceName, manifest.cluster.serviceName)
  assert.equal(service.clusterArn, manifest.cluster.arn)
  assert.equal(service.desiredCount, 1)
  assert.equal(service.runningCount, 1)
  assert.equal(service.enableExecuteCommand, false)
  assertTags(service.tags, stage, 'ECS service')
  const serviceRegistry = one(service.serviceRegistries, 'ECS API Cloud Map registry')
  assert.match(serviceRegistry.registryArn ?? '', /^arn:aws:servicediscovery:us-east-1:167217327520:service\/srv-[a-z0-9]+$/)
  const network = service.networkConfiguration?.awsvpcConfiguration
  assert.deepEqual([...(network?.subnets ?? [])].sort(), [...manifest.vpc.containerSubnets].sort())
  assert.deepEqual(network?.securityGroups, [manifest.vpc.apiSecurityGroupId])
  assert.equal(network?.assignPublicIp, 'DISABLED')
  const loadBalancer = one(service.loadBalancers, 'ECS service load balancer')
  assert.equal(loadBalancer.containerPort, 8080)
  const task = json(aws(['ecs', 'describe-task-definition', '--task-definition', service.taskDefinition, '--include', 'TAGS', '--output', 'json']), 'ECS task definition')
  const definition = task.taskDefinition
  assert.equal(definition.family, `stokd-agent-api-${stage}`)
  assert.equal(definition.networkMode, 'awsvpc')
  assert(values(definition.requiresCompatibilities).includes('FARGATE'))
  assert.equal(definition.cpu, '512')
  assert.equal(definition.memory, '1024')
  assert.equal(definition.executionRoleArn, `arn:aws:iam::${accountId}:role/stokd-agent-workload-api-${stage}-execution`)
  assert.equal(definition.taskRoleArn, `arn:aws:iam::${accountId}:role/stokd-agent-workload-api-${stage}-task`)
  assertTags(task.tags, stage, 'ECS task definition')
  const container = one(definition.containerDefinitions, 'API container definition')
  assert.match(container.image ?? '', new RegExp(`^${accountId}\\.dkr\\.ecr\\.${region}\\.amazonaws\\.com/stokd-agent-runtime@sha256:[a-f0-9]{64}$`))
  assert((container.portMappings ?? []).some(value => value.containerPort === 8080 && value.protocol === 'tcp'))
  const environment = Object.fromEntries((container.environment ?? []).map(value => [value.name, value.value]))
  assert.deepEqual(environment, {
    AGENT_STAGE: stage,
    AGENT_DATABASE_NAME: `agent_${stage.replaceAll('-', '_')}`,
    AGENT_MONGO_HOST: manifest.mongo.host,
    AGENT_REPLICA_SET: 'agent-rs',
    AGENT_RECOVERY_MODE: manifest.recoveryMode,
    NODE_ENV: 'production', PORT: '8080',
  })
  const secrets = Object.fromEntries((container.secrets ?? []).map(value => [value.name, value.valueFrom]))
  assert.deepEqual(secrets, { AGENT_RUNTIME_SECRET_VALUE: manifest.secrets.runtimeArn })
  for (const name of [...Object.keys(environment), ...Object.keys(secrets)]) {
    assert.doesNotMatch(name, /AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|BEDROCK|SAGEMAKER|ANTHROPIC|OPENAI|MODEL|PROVIDER/i)
  }
  assert.equal(container.logConfiguration?.logDriver, 'awslogs')
  assert.equal(container.logConfiguration?.options?.['awslogs-group'], `/stokd-agent/${stage}/api`)
  assert.equal(container.logConfiguration?.options?.['awslogs-region'], region)
  return {
    clusterArn: service.clusterArn, clusterName: cluster.clusterName,
    capacityProviders: [...cluster.capacityProviders].sort(), serviceArn: service.serviceArn, serviceName: service.serviceName,
    taskDefinitionArn: definition.taskDefinitionArn, taskDefinitionFamily: definition.family,
    executionRoleArn: definition.executionRoleArn, taskRoleArn: definition.taskRoleArn,
    targetGroupArn: loadBalancer.targetGroupArn, network: { subnets: [...network.subnets].sort(), securityGroups: network.securityGroups, assignPublicIp: network.assignPublicIp },
    serviceRegistryArn: serviceRegistry.registryArn,
    image: container.image, environmentNames: Object.keys(environment).sort(), secretNames: Object.keys(secrets).sort(),
  }
}

function inspectApiCloudMap(aws, manifest, ecs) {
  const id = ecs.serviceRegistryArn.split('/').at(-1)
  assert.match(id ?? '', /^srv-[a-z0-9]+$/)
  const service = json(aws(['servicediscovery', 'get-service', '--id', id, '--output', 'json']), 'API Cloud Map service').Service
  assert.equal(service.Id, id)
  assert.equal(service.Arn, ecs.serviceRegistryArn)
  assert.equal(service.NamespaceId, manifest.vpc.cloudmapNamespaceId)
  assert.ok(
    [`stokd-agent-api-${manifest.stage}`, `AgentApiService.${manifest.stage}.stokd-agent-api`].includes(service.Name),
    `API Cloud Map service name changed: ${service.Name}`,
  )
  assert.equal(service.DnsConfig?.NamespaceId, manifest.vpc.cloudmapNamespaceId)
  assert.deepEqual(service.DnsConfig?.DnsRecords?.map(record => record.Type), ['A'], 'API Cloud Map record type changed')
  const serviceTags = json(aws(['servicediscovery', 'list-tags-for-resource', '--resource-arn', service.Arn, '--output', 'json']), 'API Cloud Map service tags').Tags
  assertTags(serviceTags, manifest.stage, 'API Cloud Map service')
  return { id: service.Id, arn: service.Arn, name: service.Name, namespaceId: service.NamespaceId }
}

function assertAlbTags(aws, arn, stage, label) {
  const description = one(json(aws(['elbv2', 'describe-tags', '--resource-arns', arn, '--output', 'json']), `${label} tags`).TagDescriptions, `${label} tags`)
  assertTags(description.Tags, stage, label)
}

function inspectPublicApi(aws, manifest, ecs, albSecurityGroupId) {
  const stage = manifest.stage
  const target = one(json(aws(['elbv2', 'describe-target-groups', '--target-group-arns', ecs.targetGroupArn, '--output', 'json']), 'target group').TargetGroups, 'target group')
  assert.equal(target.Port, 8080)
  assert.equal(target.Protocol, 'HTTP')
  assert.equal(target.TargetType, 'ip')
  assert.equal(target.VpcId, manifest.vpc.id)
  assert.equal(target.HealthCheckPath, '/health')
  assert.equal(target.Matcher?.HttpCode, '200')
  assertAlbTags(aws, target.TargetGroupArn, stage, 'target group')
  const health = json(aws(['elbv2', 'describe-target-health', '--target-group-arn', target.TargetGroupArn, '--output', 'json']), 'target health').TargetHealthDescriptions ?? []
  assert(health.length >= 1 && health.every(value => value.TargetHealth?.State === 'healthy'), 'API target group is not fully healthy')
  const loadBalancerArn = one(target.LoadBalancerArns, 'target group load balancer')
  const loadBalancer = one(json(aws(['elbv2', 'describe-load-balancers', '--load-balancer-arns', loadBalancerArn, '--output', 'json']), 'load balancer').LoadBalancers, 'load balancer')
  assert.equal(loadBalancer.LoadBalancerName, `agent-${stage}`)
  assert.equal(loadBalancer.Scheme, 'internet-facing')
  assert.equal(loadBalancer.Type, 'application')
  assert.equal(loadBalancer.IpAddressType, 'ipv4')
  assert.equal(loadBalancer.VpcId, manifest.vpc.id)
  assert.deepEqual(loadBalancer.SecurityGroups, [albSecurityGroupId])
  assert.deepEqual(loadBalancer.AvailabilityZones.map(value => value.SubnetId).sort(), [...manifest.vpc.loadBalancerSubnets].sort())
  assertAlbTags(aws, loadBalancerArn, stage, 'load balancer')
  const listeners = json(aws(['elbv2', 'describe-listeners', '--load-balancer-arn', loadBalancerArn, '--output', 'json']), 'listeners').Listeners ?? []
  assert.deepEqual(listeners.map(value => value.Port).sort((a, b) => a - b), [80, 443])
  const http = one(listeners.filter(value => value.Port === 80 && value.Protocol === 'HTTP'), 'HTTP listener')
  const https = one(listeners.filter(value => value.Port === 443 && value.Protocol === 'HTTPS'), 'HTTPS listener')
  assert.equal(one(http.DefaultActions, 'HTTP listener action').RedirectConfig?.Port, '443')
  assert.equal(one(https.DefaultActions, 'HTTPS listener action').TargetGroupArn, target.TargetGroupArn)
  const listenerCertificates = json(aws(['elbv2', 'describe-listener-certificates', '--listener-arn', https.ListenerArn, '--output', 'json']), 'listener certificates').Certificates ?? []
  const certificateArn = json(aws(['ssm', 'get-parameter', '--name', '/stokd-agent/shared/validation-certificate/v1', '--output', 'json']), 'certificate parameter').Parameter?.Value
  assert.deepEqual(listenerCertificates.map(value => value.CertificateArn), [certificateArn])
  const certificate = json(aws(['acm', 'describe-certificate', '--certificate-arn', certificateArn, '--output', 'json']), 'certificate').Certificate
  assert.equal(certificate.Status, 'ISSUED')
  assert.deepEqual([certificate.DomainName, ...(certificate.SubjectAlternativeNames ?? [])].filter((value, index, all) => all.indexOf(value) === index).sort(), ['agent-restore-val12.stokd.cloud', 'agent-source-val12.stokd.cloud'])
  const certificateTags = tags(json(aws(['acm', 'list-tags-for-certificate', '--certificate-arn', certificateArn, '--output', 'json']), 'certificate tags').Tags)
  assert.equal(certificateTags.Project, 'stokd-agent')
  assert.equal(certificateTags.Custody, 'bootstrap')
  const recordName = `agent-${stage}.stokd.cloud.`
  const records = json(aws(['route53', 'list-resource-record-sets', '--hosted-zone-id', manifest.hostedZoneId, '--output', 'json']), 'Route53 records').ResourceRecordSets ?? []
  const aliasRecords = records.filter(value => value.Name === recordName && ['A', 'AAAA'].includes(value.Type) && value.AliasTarget)
  // Route 53 returns alias targets fully qualified (trailing dot) and often
  // dualstack-prefixed; the ELB API returns neither. Normalise both sides or
  // the comparison can never match.
  const normaliseAliasTarget = value => String(value ?? '').toLowerCase().replace(/^dualstack\./, '').replace(/\.$/, '')
  assert(
    aliasRecords.some(value => value.Type === 'A' && normaliseAliasTarget(value.AliasTarget.DNSName) === normaliseAliasTarget(loadBalancer.DNSName)),
    'Agent DNS A alias does not target the exact ALB',
  )
  const scalableResourceId = `service/${manifest.cluster.serviceName}/${manifest.cluster.serviceName}`
  const scalableTargets = json(aws(['application-autoscaling', 'describe-scalable-targets', '--service-namespace', 'ecs', '--resource-ids', scalableResourceId, '--scalable-dimension', 'ecs:service:DesiredCount', '--output', 'json']), 'autoscaling targets').ScalableTargets ?? []
  const scalableTarget = one(scalableTargets, 'fixed validation API scalable target')
  assert.equal(scalableTarget.ServiceNamespace, 'ecs')
  assert.equal(scalableTarget.ResourceId, scalableResourceId)
  assert.equal(scalableTarget.ScalableDimension, 'ecs:service:DesiredCount')
  assert.equal(scalableTarget.MinCapacity, 1)
  assert.equal(scalableTarget.MaxCapacity, 1)
  assert.equal(Object.values(scalableTarget.SuspendedState ?? {}).some(Boolean), false)
  assert.match(scalableTarget.ScalableTargetARN ?? '', /^arn:aws:application-autoscaling:us-east-1:167217327520:scalable-target\//)
  assert.equal(scalableTarget.RoleARN, `arn:aws:iam::${accountId}:role/aws-service-role/ecs.application-autoscaling.amazonaws.com/AWSServiceRoleForApplicationAutoScaling_ECSService`)
  const scalableTags = json(aws(['application-autoscaling', 'list-tags-for-resource', '--resource-arn', scalableTarget.ScalableTargetARN, '--output', 'json']), 'fixed validation API scalable target tags').Tags
  assertTags(Object.entries(scalableTags ?? {}).map(([Key, Value]) => ({ Key, Value })), stage, 'fixed validation API scalable target')
  const scalingPolicies = json(aws(['application-autoscaling', 'describe-scaling-policies', '--service-namespace', 'ecs', '--resource-id', scalableResourceId, '--scalable-dimension', 'ecs:service:DesiredCount', '--output', 'json']), 'autoscaling policies').ScalingPolicies ?? []
  assert.deepEqual(scalingPolicies, [], 'fixed validation API unexpectedly gained an autoscaling policy')
  const logGroups = json(aws(['logs', 'describe-log-groups', '--log-group-name-prefix', `/stokd-agent/${stage}/api`, '--output', 'json']), 'API log group').logGroups ?? []
  const logGroup = one(logGroups.filter(value => value.logGroupName === `/stokd-agent/${stage}/api`), 'API log group')
  assert.equal(logGroup.retentionInDays, 30)
  const defaultListenerRuleArns = []
  const listenerRules = listeners.flatMap(listener => {
    const rules = json(aws(['elbv2', 'describe-rules', '--listener-arn', listener.ListenerArn, '--output', 'json']), `${listener.Port} listener rules`).Rules ?? []
    const defaults = rules.filter(rule => rule.IsDefault === true)
    assert.equal(defaults.length, 1, `${listener.Port} listener must have exactly one default rule`)
    defaultListenerRuleArns.push(defaults[0].RuleArn)
    const explicit = rules.filter(rule => rule.IsDefault !== true)
    assert.deepEqual(explicit, [], `${listener.Port} validation listener unexpectedly gained a separately managed rule`)
    return explicit.map(rule => rule.RuleArn)
  })
  return {
    loadBalancer: { arn: loadBalancerArn, name: loadBalancer.LoadBalancerName, dnsName: loadBalancer.DNSName },
    targetGroup: { arn: target.TargetGroupArn, name: target.TargetGroupName },
    listeners: listeners.map(value => ({ arn: value.ListenerArn, port: value.Port, protocol: value.Protocol })),
    listenerRuleArns: listenerRules.sort(), defaultListenerRuleArns: defaultListenerRuleArns.sort(),
    certificateArn, dnsRecords: aliasRecords.map(value => ({ name: value.Name, type: value.Type, target: value.AliasTarget.DNSName })),
    autoscaling: {
      resourceId: scalableResourceId, targetArn: scalableTarget.ScalableTargetARN,
      importId: `ecs/${scalableResourceId}/ecs:service:DesiredCount`,
      roleArn: scalableTarget.RoleARN,
      minCapacity: 1, maxCapacity: 1, policiesDisabled: true, policyArns: [],
    },
    logGroup: { arn: logGroup.arn, name: logGroup.logGroupName, retentionInDays: logGroup.retentionInDays },
  }
}

function inspectStack(aws, stackName, { requireNoRoleArn = false } = {}) {
  const stack = one(json(aws(['cloudformation', 'describe-stacks', '--stack-name', stackName, '--output', 'json']), `${stackName} stack`).Stacks, `${stackName} stack`)
  assert.match(stack.StackStatus ?? '', /_COMPLETE$/)
  if (requireNoRoleArn) assert.equal(stack.RoleARN, undefined, `${stackName} unexpectedly uses a CloudFormation service role`)
  const resources = json(aws(['cloudformation', 'list-stack-resources', '--stack-name', stackName, '--output', 'json']), `${stackName} resources`).StackResourceSummaries ?? []
  assert(resources.length > 0, `${stackName} has no physical resources`)
  const template = json(aws(['cloudformation', 'get-template', '--stack-name', stackName, '--template-stage', 'Original', '--output', 'json']), `${stackName} template`).TemplateBody
  return {
    name: stack.StackName, id: stack.StackId, status: stack.StackStatus,
    parameters: Object.fromEntries((stack.Parameters ?? []).map(value => [value.ParameterKey, value.ParameterValue])),
    outputs: Object.fromEntries((stack.Outputs ?? []).map(value => [value.OutputKey, value.OutputValue])),
    templateSha256: createHash('sha256').update(typeof template === 'string' ? template : JSON.stringify(template)).digest('hex'),
    resources: resources.map(value => ({ logicalId: value.LogicalResourceId, physicalId: value.PhysicalResourceId, type: value.ResourceType })).sort((a, b) => a.logicalId.localeCompare(b.logicalId)),
  }
}

const work12PhaseNames = [
  'source-data', 'source-api-proof', 'restore-data', 'restore-api-proof',
  'source-data-redeploy', 'source-api-redeploy', 'restore-data-redeploy', 'restore-api-redeploy',
]
function classifyAgentParameter(name, stage) {
  const stageManifest = `/stokd-agent/${stage}/infrastructure-manifest/v1`
  if (name === stageManifest) return `sst-native:${stage}`
  if (name === '/stokd-agent/shared/validation-certificate/v1') return 'cloudformation-stack:stokd-agent-validation-bootstrap'
  if (/^\/stokd-agent\/(?:source|restore)-val12\/infrastructure-manifest\/v1$/.test(name)) return 'other-stage-native'
  if (name === '/stokd-agent/validation/work-1.2/restore-admission-lock/v1') return 'transient-validation-state'
  const evidenceKinds = ['evidence', 'fixture', 'physical-resources', ...work12PhaseNames.map(value => `phase-${value}`)]
  const evidence = /^\/stokd-agent\/validation\/work-1\.2\/(source-val12|restore-val12)\/([^/]+)\/v1$/.exec(name)
  if (evidence && evidenceKinds.includes(evidence[2])) return 'transient-validation-state'
  const plan = /^\/stokd-agent\/validation\/work-1\.2\/runs\/(github-[1-9][0-9]{0,19})\/phases\/([^/]+)\/plan\/v1$/.exec(name)
  if (plan && work12PhaseNames.includes(plan[2])) return 'transient-validation-state'
  throw new Error(`unclassified /stokd-agent parameter cannot enter Terraform handoff: ${name}`)
}

function inspectBootstrapAndShared(aws, manifest) {
  const bootstrap = inspectStack(aws, 'stokd-agent-validation-bootstrap', { requireNoRoleArn: true })
  const credentials = inspectStack(aws, `stokd-agent-${manifest.stage}-credentials`)
  const sstBootstrap = parseSstBootstrapParameter(aws(['ssm', 'get-parameter', '--name', SST_BOOTSTRAP_PARAMETER, '--no-with-decryption', '--output', 'json']))
  assert.equal(bootstrap.parameters.ExistingSstBootstrapVersion, String(sstBootstrap.version), 'bootstrap stack SST version binding changed')
  assert.equal(bootstrap.parameters.ExistingSstBootstrapSha256, sstBootstrap.sha256, 'bootstrap stack no longer binds the exact /sst/bootstrap value')
  assert.equal(bootstrap.parameters.ExistingSstStateBucketName, sstBootstrap.state, 'bootstrap stack SST state bucket binding changed')
  assert.equal(bootstrap.parameters.ExistingSstAssetBucketName, sstBootstrap.asset, 'bootstrap stack SST asset bucket binding changed')
  assert.equal(bootstrap.parameters.ExistingSstAssetEcrRegistryId, sstBootstrap.assetEcrRegistryId, 'bootstrap stack SST asset ECR registry binding changed')
  assert.equal(bootstrap.parameters.ExistingSstAssetEcrUrl, sstBootstrap.assetEcrUrl, 'bootstrap stack SST asset ECR URL binding changed')
  assertUsEast1BucketLocation(aws(['s3api', 'get-bucket-location', '--bucket', sstBootstrap.state, '--expected-bucket-owner', accountId, '--output', 'json']), sstBootstrap.state)
  assertUsEast1BucketLocation(aws(['s3api', 'get-bucket-location', '--bucket', sstBootstrap.asset, '--expected-bucket-owner', accountId, '--output', 'json']), sstBootstrap.asset)
  const sstStateControls = assertSstStateBucketControls({
    versioningRaw: aws(['s3api', 'get-bucket-versioning', '--bucket', sstBootstrap.state, '--expected-bucket-owner', accountId, '--output', 'json']),
    encryptionRaw: aws(['s3api', 'get-bucket-encryption', '--bucket', sstBootstrap.state, '--expected-bucket-owner', accountId, '--output', 'json']),
    publicAccessRaw: aws(['s3api', 'get-public-access-block', '--bucket', sstBootstrap.state, '--expected-bucket-owner', accountId, '--output', 'json']),
  })
  const sstStateOwnership = assertSstStateBucketOwnership(aws(['s3api', 'get-bucket-ownership-controls', '--bucket', sstBootstrap.state, '--expected-bucket-owner', accountId, '--output', 'json']))
  const sstStatePolicy = assertSstStateBucketPolicy(aws(['s3api', 'get-bucket-policy', '--bucket', sstBootstrap.state, '--expected-bucket-owner', accountId, '--output', 'json']), sstBootstrap.state)
  let sstStateLifecycleRaw
  try { sstStateLifecycleRaw = aws(['s3api', 'get-bucket-lifecycle-configuration', '--bucket', sstBootstrap.state, '--expected-bucket-owner', accountId, '--output', 'json']) }
  catch (error) {
    if (!/NoSuchLifecycleConfiguration/.test(error instanceof Error ? error.message : String(error))) throw error
    sstStateLifecycleRaw = JSON.stringify({ Rules: [] })
  }
  const sstStateLifecycle = assertSstStateLifecycle(sstStateLifecycleRaw)
  const sstAssetEcr = assertSstAssetEcr(aws(['ecr', 'describe-repositories', '--registry-id', sstBootstrap.assetEcrRegistryId, '--repository-names', 'sst-asset', '--output', 'json']), sstBootstrap)
  const ssmKeyDescription = aws(['kms', 'describe-key', '--key-id', 'alias/aws/ssm', '--output', 'json'])
  const ssmKeyId = json(ssmKeyDescription, 'AWS-managed SSM key').KeyMetadata?.KeyId
  assert.match(ssmKeyId ?? '', /^[a-f0-9-]{36}$/, 'alias/aws/ssm did not resolve an exact key ID')
  const sstPassphraseKms = assertAwsManagedSsmKms({
    describeRaw: ssmKeyDescription,
    aliasesRaw: aws(['kms', 'list-aliases', '--key-id', ssmKeyId, '--output', 'json']),
  })
  // The SST home (passphrases, initialization receipt, per-app state objects)
  // exists only where sst ran. Terraform creates none of it, so these checks
  // run in full when an SST home is present and are skipped when it is absent.
  const sstHomePresent = SST_PASSPHRASE_IDENTITIES.every(({ app, stage }) => {
    try {
      const name = sstPassphraseParameter(app, stage)
      const found = json(aws(['ssm', 'describe-parameters', '--parameter-filters', `Key=Name,Option=Equals,Values=${name}`, '--output', 'json']), `${name} presence`).Parameters ?? []
      return found.length === 1
    } catch { return false }
  })
  const sstPassphrases = !sstHomePresent ? [] : SST_PASSPHRASE_IDENTITIES.map(({ app, stage }) => {
    const name = sstPassphraseParameter(app, stage)
    const metadata = assertSstPassphraseMetadata(aws(['ssm', 'describe-parameters', '--parameter-filters', `Key=Name,Option=Equals,Values=${name}`, '--output', 'json']), app, stage)
    const tagEnvelope = json(aws(['ssm', 'list-tags-for-resource', '--resource-type', 'Parameter', '--resource-id', name, '--output', 'json']), `${name} tags`)
    const tags = Object.fromEntries((tagEnvelope.TagList ?? []).map(tag => [tag.Key, tag.Value]))
    assert.equal(tags.Project, 'stokd-agent', `${name} Project tag changed`)
    assert.equal(tags.Custody, 'work-1.2-empty-sst-home', `${name} Custody tag changed`)
    assert.match(tags.BindingSha256 ?? '', /^[a-f0-9]{64}$/, `${name} binding tag changed`)
    assert.deepEqual(Object.keys(tags).sort(), ['BindingSha256', 'Custody', 'Project'])
    return { ...metadata, tags }
  })
  const sstInitialization = sstHomePresent ? inspectCompletedSstInitialization({ aws, bootstrap: sstBootstrap }) : undefined
  const sstStageStates = !sstHomePresent ? [] : ['stokd-agent-data', 'stokd-agent-api'].map(app => {
    const key = `app/${app}/${manifest.stage}.json`
    const head = json(aws(['s3api', 'head-object', '--bucket', sstBootstrap.state, '--key', key, '--expected-bucket-owner', accountId, '--output', 'json']), `${key} SST state HEAD`)
    assert(Number.isSafeInteger(head.ContentLength) && head.ContentLength > 0, `${key} SST state is empty`)
    assert.equal(head.ServerSideEncryption, 'AES256', `${key} SST state encryption changed`)
    assert.match(head.VersionId ?? '', /^[A-Za-z0-9._=+/-]{1,1024}$/, `${key} SST state omitted its VersionId`)
    return { app, stage: manifest.stage, key, versionId: head.VersionId, byteLength: head.ContentLength }
  })
  const credentialIds = credentials.resources.filter(value => value.type === 'AWS::SecretsManager::Secret').map(value => value.physicalId).sort()
  assert.deepEqual(credentialIds, Object.values(manifest.secrets).sort())
  const repository = one(json(aws(['ecr', 'describe-repositories', '--repository-names', 'stokd-agent-runtime', '--output', 'json']), 'runtime ECR repository').repositories, 'runtime ECR repository')
  assert.equal(repository.repositoryArn, `arn:aws:ecr:${region}:${accountId}:repository/stokd-agent-runtime`)
  assert.equal(repository.imageTagMutability, 'IMMUTABLE')
  assert.equal(repository.imageScanningConfiguration?.scanOnPush, true)
  assert.equal(repository.encryptionConfiguration?.encryptionType, 'AES256')
  const lifecycle = json(aws(['ecr', 'get-lifecycle-policy', '--repository-name', 'stokd-agent-runtime', '--output', 'json']), 'ECR lifecycle')
  const repositoryPolicy = json(aws(['ecr', 'get-repository-policy', '--repository-name', 'stokd-agent-runtime', '--output', 'json']), 'ECR policy')
  const documentNames = ['stokd-agent-migrate-host-v1', 'stokd-agent-validation-seed-v1', 'stokd-agent-validation-backup-v1', 'stokd-agent-restore-host-v1']
  const documents = documentNames.map(name => {
    const document = json(aws(['ssm', 'describe-document', '--name', name, '--output', 'json']), `${name} document`).Document
    assert.equal(document.Name, name)
    assert.equal(document.DocumentFormat, 'YAML')
    assert.equal(document.DocumentType, 'Command')
    assert.equal(document.Status, 'Active')
    const deployed = json(aws(['ssm', 'get-document', '--name', name, '--document-version', document.DocumentVersion, '--document-format', 'JSON', '--output', 'json']), `${name} deployed content`)
    assert.equal(deployed.DocumentVersion, document.DocumentVersion)
    assert.deepEqual(json(deployed.Content, `${name} deployed content body`), expectedHostDocuments[name], `${name} deployed command content changed`)
    return { name, version: document.DocumentVersion, hash: document.Hash, status: document.Status, contentSha256: createHash('sha256').update(deployed.Content).digest('hex') }
  })
  const parameters = json(aws(['ssm', 'describe-parameters', '--parameter-filters', 'Key=Name,Option=BeginsWith,Values=/stokd-agent/', '--output', 'json']), 'Agent parameters').Parameters ?? []
  const parameterNames = parameters.map(value => value.Name).sort()
  assert(parameterNames.includes(`/stokd-agent/${manifest.stage}/infrastructure-manifest/v1`))
  assert(parameterNames.includes('/stokd-agent/shared/validation-certificate/v1'))
  const oidc = json(aws(['iam', 'get-open-id-connect-provider', '--open-id-connect-provider-arn', `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`, '--output', 'json']), 'GitHub OIDC provider')
  assert(oidc.ClientIDList?.includes('sts.amazonaws.com'))
  return {
    stacks: { bootstrap, credentials },
    repository: {
      arn: repository.repositoryArn, name: repository.repositoryName, uri: repository.repositoryUri,
      lifecycleSha256: createHash('sha256').update(lifecycle.lifecyclePolicyText).digest('hex'),
      policySha256: createHash('sha256').update(repositoryPolicy.policyText).digest('hex'),
    },
    documents, parameterNames,
    sstBootstrap: {
      parameterName: SST_BOOTSTRAP_PARAMETER,
      parameterVersion: sstBootstrap.parameterVersion,
      valueSha256: sstBootstrap.sha256,
      version: sstBootstrap.version,
      stateBucket: sstBootstrap.state,
      assetBucket: sstBootstrap.asset,
      assetEcrRegistryId: sstBootstrap.assetEcrRegistryId,
      assetEcrUrl: sstBootstrap.assetEcrUrl,
      assetEcrArn: sstAssetEcr.repositoryArn,
      stateControls: { ...sstStateControls, ownership: sstStateOwnership, policy: sstStatePolicy, lifecycle: sstStateLifecycle },
      passphraseKms: sstPassphraseKms,
      passphrases: sstPassphrases,
      initialization: sstInitialization,
      stageStates: sstStageStates,
    },
    githubOidcProviderArn: `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`,
  }
}

export async function inspectAgentControlPlane({ aws, manifest }) {
  if (typeof aws !== 'function') throw new Error('AWS readback boundary is required')
  const stage = manifest?.stage
  assert(['source-val12', 'restore-val12'].includes(stage), 'manifest stage is invalid')
  assert.equal(manifest.accountId, accountId)
  assert.equal(manifest.region, region)

  const vpc = one(json(aws(['ec2', 'describe-vpcs', '--vpc-ids', manifest.vpc.id, '--output', 'json']), 'VPC readback').Vpcs, 'VPC')
  assert.equal(vpc.State, 'available')
  assertTags(vpc.Tags, stage, 'VPC')
  const vpcCidr = vpc.CidrBlock

  const allSubnetIds = [...manifest.vpc.containerSubnets, ...manifest.vpc.loadBalancerSubnets]
  const subnets = json(aws(['ec2', 'describe-subnets', '--subnet-ids', ...allSubnetIds, '--output', 'json']), 'subnet readback').Subnets
  assert.deepEqual(subnets.map(value => value.SubnetId).sort(), [...allSubnetIds].sort())
  for (const subnet of subnets) {
    assert.equal(subnet.VpcId, manifest.vpc.id)
    assertTags(subnet.Tags, stage, `${subnet.SubnetId} subnet`)
    const isPrivate = manifest.vpc.containerSubnets.includes(subnet.SubnetId)
    assert.equal(subnet.MapPublicIpOnLaunch, !isPrivate, `${subnet.SubnetId} public-IP behavior changed`)
  }

  const privateRouteTableIds = []
  const publicRouteTableIds = []
  const routeTables = []
  const internetGatewayIds = new Set()
  for (const subnetId of allSubnetIds) {
    const table = one(json(aws(['ec2', 'describe-route-tables', '--filters', `Name=association.subnet-id,Values=${subnetId}`, '--output', 'json']), `${subnetId} route table`).RouteTables, `${subnetId} route table`)
    assert.equal(table.VpcId, manifest.vpc.id)
    assertTags(table.Tags, stage, `${subnetId} route table`)
    const defaultRoutes = (table.Routes ?? []).filter(route => route.DestinationCidrBlock === '0.0.0.0/0' || route.DestinationIpv6CidrBlock === '::/0')
    if (manifest.vpc.containerSubnets.includes(subnetId)) {
      assert.equal(defaultRoutes.length, 0, `${subnetId} private subnet gained Internet egress`)
      privateRouteTableIds.push(table.RouteTableId)
    } else {
      assert.equal(defaultRoutes.length, 1, `${subnetId} public ALB subnet lost its exact default route`)
      assert.match(defaultRoutes[0].GatewayId ?? '', /^igw-[a-f0-9]{17}$/)
      internetGatewayIds.add(defaultRoutes[0].GatewayId)
      publicRouteTableIds.push(table.RouteTableId)
    }
    assert.equal((table.Routes ?? []).some(route => route.NatGatewayId), false, `${subnetId} gained a NAT route`)
    const association = one((table.Associations ?? []).filter(value => value.SubnetId === subnetId), `${subnetId} route-table association`)
    routeTables.push({
      id: table.RouteTableId, subnetId, associationId: association.RouteTableAssociationId,
      associationImportId: `${subnetId}/${table.RouteTableId}`,
      public: manifest.vpc.loadBalancerSubnets.includes(subnetId),
      defaultRouteImportId: defaultRoutes.length === 1 ? `${table.RouteTableId}_${defaultRoutes[0].DestinationCidrBlock ?? defaultRoutes[0].DestinationIpv6CidrBlock}` : null,
    })
  }
  assert.equal(internetGatewayIds.size, 1)
  const internetGateway = one(json(aws(['ec2', 'describe-internet-gateways', '--internet-gateway-ids', ...internetGatewayIds, '--output', 'json']), 'Internet gateway').InternetGateways, 'Internet gateway')
  assert((internetGateway.Attachments ?? []).some(value => value.VpcId === manifest.vpc.id && value.State === 'available'))
  assertTags(internetGateway.Tags, stage, 'Internet gateway')
  const nat = json(aws(['ec2', 'describe-nat-gateways', '--filter', `Name=vpc-id,Values=${manifest.vpc.id}`, 'Name=state,Values=pending,available', '--output', 'json']), 'NAT readback')
  assert.deepEqual(nat.NatGateways ?? [], [], 'Agent VPC gained a NAT gateway')

  const endpoints = json(aws(['ec2', 'describe-vpc-endpoints', '--filters', `Name=vpc-id,Values=${manifest.vpc.id}`, 'Name=tag:Project,Values=stokd-agent', `Name=tag:Stage,Values=${stage}`, '--output', 'json']), 'VPC endpoint readback').VpcEndpoints
  assert.deepEqual(endpoints.map(value => value.ServiceName).sort(), expectedEndpointServices)
  const s3Endpoint = one(endpoints.filter(value => value.ServiceName.endsWith('.s3')), 'S3 endpoint')
  assert.equal(s3Endpoint.VpcEndpointType, 'Gateway')
  assert.deepEqual([...s3Endpoint.RouteTableIds].sort(), [...new Set(privateRouteTableIds)].sort())
  const interfaceEndpoints = endpoints.filter(value => value !== s3Endpoint)
  for (const endpoint of interfaceEndpoints) {
    assert.equal(endpoint.State, 'available')
    assert.equal(endpoint.VpcEndpointType, 'Interface')
    assert.equal(endpoint.PrivateDnsEnabled, true)
    assert.deepEqual([...endpoint.SubnetIds].sort(), [...manifest.vpc.containerSubnets].sort())
  }
  const endpointGroupIds = [...new Set(interfaceEndpoints.flatMap(value => (value.Groups ?? []).map(group => group.GroupId)))]
  assert.equal(endpointGroupIds.length, 1)
  const endpointGroupId = endpointGroupIds[0]

  const groups = json(aws(['ec2', 'describe-security-groups', '--filters', `Name=vpc-id,Values=${manifest.vpc.id}`, 'Name=tag:Project,Values=stokd-agent', `Name=tag:Stage,Values=${stage}`, '--output', 'json']), 'security group readback').SecurityGroups
  const groupById = new Map(groups.map(group => [group.GroupId, group]))
  const endpointGroup = groupById.get(endpointGroupId)
  const apiGroup = groupById.get(manifest.vpc.apiSecurityGroupId)
  const mongoGroup = groupById.get(manifest.vpc.mongoSecurityGroupId)
  const albGroup = one(groups.filter(group => group.GroupName === `stokd-agent-alb-exact-${stage}`), 'exact ALB security group')
  // SST's Service component always created its own load-balancer security
  // group, which this topology left unused by binding the ALB to the exact
  // group instead; the assertion below proved it stayed empty. Terraform binds
  // the ALB directly and creates no such component group, so there is nothing
  // to prove -- absence is strictly stronger than "present but empty".
  const unusedAlbGroup = groups.find(group => group.GroupName === `stokd-agent-alb-component-unused-${stage}`)
  const defaultGroup = one(groups.filter(group => group.GroupName === 'default'), 'VPC default security group')
  assert(endpointGroup && apiGroup && mongoGroup, 'required workload security group is missing')
  for (const [group, label] of [[endpointGroup, 'endpoint'], [apiGroup, 'API'], [mongoGroup, 'Mongo'], [albGroup, 'ALB'], [defaultGroup, 'default VPC']]) assertTags(group.Tags, stage, `${label} security group`)
  const s3Prefix = one((s3Endpoint.RouteTableIds ?? []).length ? json(aws(['ec2', 'describe-prefix-lists', '--filters', `Name=prefix-list-name,Values=com.amazonaws.${region}.s3`, '--output', 'json']), 'S3 prefix list').PrefixLists : [], 'S3 prefix list').PrefixListId
  assertExactPermissions(endpointGroup,
    [`tcp:443:443:sg:${apiGroup.GroupId}`, `tcp:443:443:sg:${mongoGroup.GroupId}`], [], 'endpoint security group')
  assertExactPermissions(mongoGroup,
    [`tcp:27017:27017:sg:${apiGroup.GroupId}`],
    [`tcp:443:443:sg:${endpointGroup.GroupId}`, `tcp:443:443:prefix:${s3Prefix}`, `tcp:53:53:ipv4:${vpcCidr}`, `udp:53:53:ipv4:${vpcCidr}`], 'Mongo security group')
  assertExactPermissions(apiGroup,
    [`tcp:8080:8080:sg:${albGroup.GroupId}`],
    [`tcp:27017:27017:sg:${mongoGroup.GroupId}`, `tcp:443:443:sg:${endpointGroup.GroupId}`, `tcp:443:443:prefix:${s3Prefix}`, `tcp:53:53:ipv4:${vpcCidr}`, `udp:53:53:ipv4:${vpcCidr}`], 'API security group')
  assertExactPermissions(albGroup,
    ['tcp:443:443:ipv4:0.0.0.0/0', 'tcp:80:80:ipv4:0.0.0.0/0'],
    [`tcp:8080:8080:sg:${apiGroup.GroupId}`], 'ALB security group')
  if (unusedAlbGroup) {
    assertTags(unusedAlbGroup.Tags, stage, 'unused SST ALB security group')
    assertExactPermissions(unusedAlbGroup, [], [], 'unused SST ALB security group')
  }
  assertExactPermissions(defaultGroup, [], [], 'default VPC security group')
  for (const group of groups) assert.equal(permissionSignatures(group.IpPermissionsEgress).some(value => value.endsWith(':ipv4:0.0.0.0/0') || value.endsWith(':ipv6:::/0')), false, `${group.GroupName} gained public egress`)
  const securityGroupRules = json(aws(['ec2', 'describe-security-group-rules', '--filters', `Name=group-id,Values=${groups.map(value => value.GroupId).join(',')}`, '--output', 'json']), 'security group rules').SecurityGroupRules ?? []

  const kmsKeyArn = manifest.custody.kmsKeyArn
  const kms = inspectKms(aws, manifest)

  const buckets = [
    inspectBucket(aws, manifest.custody.artifactBucket, kmsKeyArn, stage),
    inspectBucket(aws, manifest.custody.backupBucket, kmsKeyArn, stage),
  ]
  const stageSecretArns = exactStageSecretArns(manifest.secrets, stage)
  const secretVersions = {}
  for (const [kind, secretArn] of Object.entries({ runtime: manifest.secrets.runtimeArn, migration: manifest.secrets.migrationArn, backup: manifest.secrets.backupArn })) {
    const secret = json(aws(['secretsmanager', 'describe-secret', '--secret-id', secretArn, '--output', 'json']), `${kind} secret`)
    assert.equal(secret.ARN, secretArn)
    assert.equal(secret.KmsKeyId, kmsKeyArn)
    assert.equal(secret.DeletedDate, undefined)
    assertTags(secret.Tags, stage, `${kind} secret`)
    const versions = json(aws(['secretsmanager', 'list-secret-version-ids', '--secret-id', secretArn, '--include-deprecated', '--output', 'json']), `${kind} secret versions`).Versions
    const current = versions.filter(value => value.VersionStages?.includes('AWSCURRENT'))
    assert.equal(current.length, 1, `${kind} secret must have one AWSCURRENT version`)
    secretVersions[kind] = current[0].VersionId
  }

  const volume = one(json(aws(['ec2', 'describe-volumes', '--volume-ids', manifest.mongo.volumeId, '--output', 'json']), 'EBS volume').Volumes, 'EBS volume')
  assert.equal(volume.Encrypted, true)
  assert.equal(volume.KmsKeyId, kmsKeyArn)
  assert.equal(volume.VolumeType, 'gp3')
  assert.equal(volume.Size, 30)
  assert.equal(volume.Iops, 3000)
  assert.equal(volume.Throughput, 125)
  assert.equal(volume.State, 'in-use')
  assertTags(volume.Tags, stage, 'EBS volume')
  assert((volume.Attachments ?? []).some(value => value.InstanceId === manifest.mongo.instanceId && value.Device === '/dev/sdf' && value.State === 'attached'), 'data volume is not attached to exact Mongo host')

  const instance = one(json(aws(['ec2', 'describe-instances', '--instance-ids', manifest.mongo.instanceId, '--output', 'json']), 'Mongo instance').Reservations.flatMap(value => value.Instances ?? []), 'Mongo instance')
  assert.equal(instance.State?.Name, 'running')
  assert.equal(instance.PublicIpAddress, undefined)
  assert(manifest.vpc.containerSubnets.includes(instance.SubnetId), 'Mongo host escaped private subnets')
  assert.deepEqual((instance.SecurityGroups ?? []).map(value => value.GroupId), [manifest.vpc.mongoSecurityGroupId])
  assert.equal(instance.IamInstanceProfile?.Arn, `arn:aws:iam::${accountId}:instance-profile/stokd-agent-workload-mongo-${stage}`)
  assert.equal(instance.MetadataOptions?.HttpTokens, 'required')
  assert.equal(instance.MetadataOptions?.HttpPutResponseHopLimit, 1)
  assertTags(instance.Tags, stage, 'Mongo instance')
  const rootMapping = one((instance.BlockDeviceMappings ?? []).filter(value => value.DeviceName === instance.RootDeviceName), 'Mongo root volume mapping')
  assert.equal(rootMapping.Ebs?.DeleteOnTermination, true)
  assert.match(rootMapping.Ebs?.VolumeId ?? '', /^vol-[a-f0-9]{17}$/)
  const rootVolume = one(json(aws(['ec2', 'describe-volumes', '--volume-ids', rootMapping.Ebs.VolumeId, '--output', 'json']), 'Mongo root volume').Volumes, 'Mongo root volume')
  assert.equal(rootVolume.Encrypted, true)
  assert.equal(rootVolume.KmsKeyId, kmsKeyArn)
  assert.equal(rootVolume.VolumeType, 'gp3')
  // The pinned AMI's root snapshot is 30 GiB, so the root volume cannot be
  // smaller. This is the OS disk; MongoDB data lives on the retained volume.
  assert.equal(rootVolume.Size, 30)
  assertTags(rootVolume.Tags, stage, 'Mongo root volume')
  const networkInterface = one(json(aws(['ec2', 'describe-network-interfaces', '--network-interface-ids', manifest.mongo.networkInterfaceId, '--output', 'json']), 'Mongo ENI').NetworkInterfaces, 'Mongo ENI')
  assert.equal(networkInterface.Status, 'in-use')
  assert.equal(networkInterface.SubnetId, instance.SubnetId)
  assert.equal(networkInterface.Attachment?.InstanceId, instance.InstanceId)
  assert.deepEqual(networkInterface.Groups.map(value => value.GroupId), [manifest.vpc.mongoSecurityGroupId])
  assertTags(networkInterface.TagSet, stage, 'Mongo ENI')
  const cloudMap = inspectCloudMap(aws, manifest, networkInterface)

  const mongoSecretReadResources = [...stageSecretArns]
  if (stage === 'restore-val12') {
    const sourceEnvelope = json(aws(['ssm', 'get-parameter', '--name', '/stokd-agent/source-val12/infrastructure-manifest/v1', '--output', 'json']), 'source manifest for restore-role secret scope')
    const sourceManifest = json(sourceEnvelope.Parameter?.Value, 'source manifest for restore-role secret scope')
    assert.equal(sourceManifest.schemaVersion, '1.0')
    assert.equal(sourceManifest.stage, 'source-val12')
    assert.equal(sourceManifest.sourceDigest, manifest.sourceDigest)
    mongoSecretReadResources.push(...exactStageSecretArns(sourceManifest.secrets, 'source-val12', 'restore-role source secrets'))
  }
  const roles = []
  roles.push(inspectRole(aws, `stokd-agent-workload-mongo-${stage}`, 'ec2.amazonaws.com', stage, mongoSecretReadResources))
  roles.push(inspectRole(aws, `stokd-agent-workload-api-${stage}-execution`, 'ecs-tasks.amazonaws.com', stage, [manifest.secrets.runtimeArn]))
  roles.push(inspectRole(aws, `stokd-agent-workload-api-${stage}-task`, 'ecs-tasks.amazonaws.com', stage, []))
  roles.push(inspectDeployRole(aws))
  const profile = json(aws(['iam', 'get-instance-profile', '--instance-profile-name', `stokd-agent-workload-mongo-${stage}`, '--output', 'json']), 'Mongo instance profile').InstanceProfile
  assert.deepEqual(profile.Roles?.map(value => value.RoleName), [`stokd-agent-workload-mongo-${stage}`])

  const ecs = inspectEcsApi(aws, manifest)
  assert.equal(ecs.executionRoleArn, roles.find(value => value.roleName.endsWith('-execution')).arn)
  assert.equal(ecs.taskRoleArn, roles.find(value => value.roleName.endsWith('-task')).arn)
  const apiCloudMap = inspectApiCloudMap(aws, manifest, ecs)
  const publicApi = inspectPublicApi(aws, manifest, ecs, albGroup.GroupId)
  const shared = inspectBootstrapAndShared(aws, manifest)

  const workloadRoles = roles.filter(value => value.roleName !== 'stokd-agent-validation-deploy')
  const securityGroupRuleImports = securityGroupRules.map(value => {
    assert.match(value.SecurityGroupRuleId ?? '', /^sgr-[a-f0-9]{17}$/)
    assert.equal(typeof value.IsEgress, 'boolean')
    return { kind: value.IsEgress ? 'aws_vpc_security_group_egress_rule' : 'aws_vpc_security_group_ingress_rule', importId: value.SecurityGroupRuleId }
  })
  const stageManifestParameter = `/stokd-agent/${stage}/infrastructure-manifest/v1`
  const parameterOwnership = shared.parameterNames.map(name => ({ name, owner: classifyAgentParameter(name, stage) }))
  const stageNativeImports = [
    { kind: 'aws_vpc', importId: vpc.VpcId },
    ...subnets.map(value => ({ kind: 'aws_subnet', importId: value.SubnetId })),
    { kind: 'aws_internet_gateway', importId: internetGateway.InternetGatewayId },
    ...routeTables.flatMap(value => [
      { kind: 'aws_route_table', importId: value.id },
      { kind: 'aws_route_table_association', importId: value.associationImportId },
      ...(value.defaultRouteImportId ? [{ kind: 'aws_route', importId: value.defaultRouteImportId }] : []),
    ]),
    ...endpoints.map(value => ({ kind: 'aws_vpc_endpoint', importId: value.VpcEndpointId })),
    ...groups.filter(value => value.GroupId !== defaultGroup.GroupId).map(value => ({ kind: 'aws_security_group', importId: value.GroupId })),
    { kind: 'aws_default_security_group', importId: defaultGroup.GroupId },
    ...securityGroupRuleImports,
    { kind: 'aws_kms_key', importId: kms.keyId }, { kind: 'aws_kms_alias', importId: kms.aliasName },
    ...buckets.flatMap(value => ['aws_s3_bucket', 'aws_s3_bucket_policy', 'aws_s3_bucket_public_access_block', 'aws_s3_bucket_ownership_controls', 'aws_s3_bucket_versioning', 'aws_s3_bucket_server_side_encryption_configuration', 'aws_s3_bucket_lifecycle_configuration'].map(kind => ({ kind, importId: value.bucket }))),
    { kind: 'aws_service_discovery_private_dns_namespace', importId: cloudMap.namespace.id },
    { kind: 'aws_service_discovery_service', importId: cloudMap.service.id },
    { kind: 'aws_service_discovery_instance', importId: `${cloudMap.service.id}/${cloudMap.instance.id}` },
    { kind: 'aws_service_discovery_service', importId: apiCloudMap.id },
    { kind: 'aws_iam_instance_profile', importId: profile.InstanceProfileName },
    ...workloadRoles.flatMap(value => [
      { kind: 'aws_iam_role', importId: value.roleName },
      ...value.inlinePolicies.map(policyName => ({ kind: 'aws_iam_role_policy', importId: `${value.roleName}:${policyName}` })),
    ]),
    { kind: 'aws_network_interface', importId: networkInterface.NetworkInterfaceId },
    { kind: 'aws_ebs_volume', importId: volume.VolumeId },
    { kind: 'aws_volume_attachment', importId: `/dev/sdf:${volume.VolumeId}:${instance.InstanceId}` },
    { kind: 'aws_instance', importId: instance.InstanceId },
    { kind: 'aws_ecs_cluster', importId: manifest.cluster.serviceName },
    { kind: 'aws_ecs_cluster_capacity_providers', importId: manifest.cluster.serviceName },
    { kind: 'aws_ecs_service', importId: `${manifest.cluster.serviceName}/${manifest.cluster.serviceName}` },
    { kind: 'aws_ecs_task_definition', importId: ecs.taskDefinitionArn },
    { kind: 'aws_appautoscaling_target', importId: publicApi.autoscaling.importId },
    { kind: 'aws_lb', importId: publicApi.loadBalancer.arn },
    { kind: 'aws_lb_target_group', importId: publicApi.targetGroup.arn },
    ...publicApi.listeners.map(value => ({ kind: 'aws_lb_listener', importId: value.arn })),
    ...publicApi.listenerRuleArns.map(value => ({ kind: 'aws_lb_listener_rule', importId: value })),
    { kind: 'aws_cloudwatch_log_group', importId: publicApi.logGroup.name },
    ...publicApi.dnsRecords.map(value => ({ kind: 'aws_route53_record', importId: `${manifest.hostedZoneId}_${value.name.replace(/\.$/, '')}_${value.type}` })),
    { kind: 'aws_ssm_parameter', importId: stageManifestParameter },
  ].filter(value => typeof value.importId === 'string' && value.importId.length > 0)

  const cloudFormationOwnership = [
    {
      scope: `credentials:${stage}`, selectedModel: 'cloudformation-stack-bridge',
      stackName: shared.stacks.credentials.name, stackId: shared.stacks.credentials.id,
      import: { kind: 'aws_cloudformation_stack', importId: shared.stacks.credentials.name },
      templateSha256: shared.stacks.credentials.templateSha256,
      parameters: shared.stacks.credentials.parameters,
      ownedChildren: shared.stacks.credentials.resources,
      rejectedAlternative: 'native-child-imports-until-stack-ownership-is-explicitly-removed',
    },
    ...(stage === 'source-val12' ? [{
      scope: 'shared-bootstrap', selectedModel: 'cloudformation-stack-bridge', emittedByStage: 'source-val12',
      stackName: shared.stacks.bootstrap.name, stackId: shared.stacks.bootstrap.id,
      import: { kind: 'aws_cloudformation_stack', importId: shared.stacks.bootstrap.name },
      templateSha256: shared.stacks.bootstrap.templateSha256,
      parameters: shared.stacks.bootstrap.parameters,
      ownedChildren: shared.stacks.bootstrap.resources,
      rejectedAlternative: 'native-child-imports-until-stack-ownership-is-explicitly-removed',
    }] : []),
  ]
  const imports = [...stageNativeImports, ...cloudFormationOwnership.map(value => value.import)]
    .sort((left, right) => `${left.kind}:${left.importId}`.localeCompare(`${right.kind}:${right.importId}`))
  assert.equal(new Set(imports.map(value => `${value.kind}\0${value.importId}`)).size, imports.length, 'Terraform handoff contains a duplicate remote-object import')

  const sstCustody = shared.sstBootstrap.initialization.externalCustody
  const externalRetainedCustody = {
    ownership: 'external-reference-only-never-import-or-reconfigure',
    stateBucket: shared.sstBootstrap.stateBucket,
    stateBucketControls: shared.sstBootstrap.stateControls,
    passphraseParameters: shared.sstBootstrap.passphrases,
    encryptedSecretObjects: sstCustody.secretObjects,
    globalTerminal: shared.sstBootstrap.initialization.terminal,
    homeTerminals: sstCustody.homeTerminals,
    activeMarker: {
      ...sstCustody.activeMarker,
      currentState: sstCustody.activeMarkerCurrentState,
      history: sstCustody.activeMarkerHistory,
    },
    retainedVersionInventory: sstCustody.observedRetainedVersionInventory,
    initializationFailureReceiptPrefix: sstCustody.failureReceiptPrefix,
    dynamicNamespaces: SST_HOME_IDENTITIES.flatMap(({ app, stage: homeStage }) => [
      `update/${app}/${homeStage}/`, `snapshot/${app}/${homeStage}/`, `eventlog/${app}/${homeStage}/`,
    ]),
  }

  const terraformMigrationInventory = {
    schemaVersion: '1.0', stage,
    importContract: { minimumTerraformVersion: '1.5.0', syntax: 'id', awsProviderMajor: 6 },
    selectedOwnershipModel: 'sst-native-resources-plus-cloudformation-stack-bridges',
    imports,
    cloudFormationOwnership,
    externalRetainedCustody,
    sharedBootstrapOwnership: stage === 'source-val12'
      ? { emittedByStage: 'source-val12', importRequiredHere: true }
      : { emittedByStage: 'source-val12', importRequiredHere: false, stackName: shared.stacks.bootstrap.name },
    parameterOwnership,
    externalReferences: [
      { kind: 'aws_iam_openid_connect_provider', id: shared.githubOidcProviderArn, owner: 'pre-existing-shared-account-infrastructure' },
      { kind: 'aws_route53_zone', id: manifest.hostedZoneId, owner: 'pre-existing-stokd-cloud-dns' },
      { kind: 'aws_iam_service_linked_role', id: publicApi.autoscaling.roleArn, owner: 'aws-managed-shared-account-service-role' },
      { kind: 'aws_ssm_parameter', id: shared.sstBootstrap.parameterName, owner: 'pre-existing-sst-bootstrap-external-input' },
      { kind: 'aws_s3_bucket', id: shared.sstBootstrap.stateBucket, owner: 'pre-existing-sst-home-state-external-input' },
      { kind: 'aws_s3_bucket', id: shared.sstBootstrap.assetBucket, owner: 'pre-existing-sst-asset-external-input' },
      { kind: 'aws_ecr_repository', id: shared.sstBootstrap.assetEcrArn, owner: 'pre-existing-sst-asset-external-input' },
      { kind: 'aws_kms_key', id: shared.sstBootstrap.passphraseKms.arn, owner: 'aws-managed-ssm-key-external-input' },
    ],
    excludedPhysicalResources: [
      { kind: 'aws_ebs_volume', id: rootVolume.VolumeId, reason: 'owned-by-aws_instance-root_block_device-delete_on_termination' },
      ...publicApi.defaultListenerRuleArns.map(value => ({ kind: 'aws_lb_listener_rule', id: value, reason: 'default-action-is-owned-by-aws_lb_listener' })),
      ...parameterOwnership.filter(value => value.owner !== `sst-native:${stage}`).map(value => ({ kind: 'aws_ssm_parameter', id: value.name, reason: value.owner })),
    ],
    retainedCustody: [
      { kind: 'aws_kms_key', importId: kms.keyId, requiredLifecycle: 'prevent_destroy' },
      ...buckets.map(value => ({ kind: 'aws_s3_bucket', importId: value.bucket, requiredLifecycle: 'prevent_destroy-and-preserve-version-history' })),
      { kind: 'aws_ebs_volume', importId: volume.VolumeId, requiredLifecycle: 'prevent_destroy-and-preserve-attachment-identity' },
      { kind: 'aws_cloudformation_stack', importId: shared.stacks.credentials.name, requiredLifecycle: 'retain-stack-and-secret-children-during-bridge' },
      ...(stage === 'source-val12' ? [{ kind: 'aws_cloudformation_stack', importId: shared.stacks.bootstrap.name, requiredLifecycle: 'prevent_destroy-and-retain-stack-children-during-bridge' }] : []),
    ],
    behavioralContracts: {
      orderedValidationPhases: ['source-data', 'source-api-proof', 'restore-data', 'restore-api-proof', 'source-data-redeploy', 'source-api-redeploy', 'restore-data-redeploy', 'restore-api-redeploy'],
      restoreAdmissionLockParameter: '/stokd-agent/validation/work-1.2/restore-admission-lock/v1',
      apiDesiredCount: 1, apiCapacityBounds: [1, 1], apiAutoscalingPolicies: false, restoreStageMode: 'restored_observation',
      privateNatGateways: 0, cloudModelInvokeAllowed: false,
    },
    stateTransition: {
      source: 'terraform-1.5.7-s3-state',
      sstStateIdentities: [`stokd-agent-data/${stage}`, `stokd-agent-api/${stage}`],
      sstHomeExternalInputs: {
        bootstrapParameter: shared.sstBootstrap.parameterName,
        bootstrapValueSha256: shared.sstBootstrap.valueSha256,
        bootstrapParameterVersion: shared.sstBootstrap.parameterVersion,
        bootstrapSchemaVersion: shared.sstBootstrap.version,
        stateBucket: shared.sstBootstrap.stateBucket,
        assetBucket: shared.sstBootstrap.assetBucket,
        assetEcrArn: shared.sstBootstrap.assetEcrArn,
        awsManagedSsmKeyArn: shared.sstBootstrap.passphraseKms.arn,
        passphraseParameters: shared.sstBootstrap.passphrases,
        encryptedSecretObjects: sstCustody.secretObjects,
        globalTerminal: shared.sstBootstrap.initialization.terminal,
        homeTerminals: sstCustody.homeTerminals,
        activeMarker: { ...sstCustody.activeMarker, currentState: sstCustody.activeMarkerCurrentState },
        retainedVersionInventory: sstCustody.observedRetainedVersionInventory,
        stateBucketControls: shared.sstBootstrap.stateControls,
        terraformOwnership: 'external-reference-only-never-import-or-reconfigure',
      },
      order: ['author-target-terraform-resources', 'import-each-selected-remote-object-once', 'prove-no-op-plan-and-retained-custody', 'retire-sst-state-without-cloud-deletes'],
    },
  }

  return {
    schemaVersion: '1.0', stage, observedAt: new Date().toISOString(),
    vpcId: vpc.VpcId, subnetIds: allSubnetIds.sort(), internetGatewayId: internetGateway.InternetGatewayId,
    routeTables, privateRouteTableIds: [...new Set(privateRouteTableIds)].sort(), publicRouteTableIds: [...new Set(publicRouteTableIds)].sort(),
    endpointIds: endpoints.map(value => value.VpcEndpointId).sort(),
    securityGroupIds: { endpoint: endpointGroup.GroupId, api: apiGroup.GroupId, mongo: mongoGroup.GroupId, alb: albGroup.GroupId, unusedAlb: unusedAlbGroup.GroupId, defaultVpc: defaultGroup.GroupId }, securityGroupRuleIds: securityGroupRules.map(value => value.SecurityGroupRuleId).sort(),
    buckets, kms, secretVersions, cloudMap, apiCloudMap, ecs, publicApi, shared,
    volume: { volumeId: volume.VolumeId, rootVolumeId: rootVolume.VolumeId, rootVolumeDeleteOnTermination: true, instanceId: instance.InstanceId, networkInterfaceId: networkInterface.NetworkInterfaceId, instanceProfileArn: profile.Arn, encrypted: true, attachmentState: 'attached' }, roles,
    terraformMigrationInventory,
    privateInternetEgressDenied: true, stokdServiceEgressDenied: true, cloudModelInvokeAllowed: false,
  }
}

export const controlPlanePolicy = { expectedEndpointServices, forbiddenModelAction }

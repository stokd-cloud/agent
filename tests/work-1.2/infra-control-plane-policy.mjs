import assert from 'node:assert/strict'
import test from 'node:test'
import { assertEffectiveSecretReadScope, assertExactDeployCustodyDenials, assertExactDeployPolicySet, assertExactDeployTrust, assertExactSendCommandScope, assertExactServiceTrust, assertNoEffectiveModelOrExecutor, exactStageSecretArns } from '../../scripts/infra-control-plane-readback.mjs'

const policy = (...Statement) => ({ Version: '2012-10-17', Statement })
const allow = Action => ({ Effect: 'Allow', Action, Resource: '*' })
const deny = Action => ({ Effect: 'Deny', Action, Resource: '*' })
const deployBoundaryArn = 'arn:aws:iam::167217327520:policy/stokd-agent-validation-deploy-boundary'
const deployPolicyArns = ['foundation', 'runtime', 'custody', 'control', 'sst-home']
  .map(name => `arn:aws:iam::167217327520:policy/stokd-agent-validation-deploy-${name}`)

test('deploy role requires the exact five attached policies, zero inline policies, and immutable boundary', () => {
  const exact = { inlinePolicyNames: [], attachedPolicyArns: deployPolicyArns, boundaryArn: deployBoundaryArn }
  assert.doesNotThrow(() => assertExactDeployPolicySet(exact))
  assert.throws(() => assertExactDeployPolicySet({ ...exact, inlinePolicyNames: ['widening'] }), /zero inline policies/)
  assert.throws(() => assertExactDeployPolicySet({ ...exact, attachedPolicyArns: [...deployPolicyArns, 'arn:aws:iam::167217327520:policy/widening'] }), /attached policy set changed/)
  assert.throws(() => assertExactDeployPolicySet({ ...exact, attachedPolicyArns: deployPolicyArns.slice(0, -1) }), /attached policy set changed/)
  assert.throws(() => assertExactDeployPolicySet({ ...exact, boundaryArn: 'arn:aws:iam::167217327520:policy/widening' }), /permissions boundary changed/)
})

test('deployed policy readback requires all exact retained-custody denials', () => {
  const persistentDeletion = {
    Sid: 'PersistentDeletionIsImpossible', Effect: 'Deny',
    Action: ['ec2:DeleteVolume', 'ecs:ExecuteCommand', 'ecs:RunTask', 'ecs:StartTask', 'events:*', 'kms:DisableKey', 'kms:ScheduleKeyDeletion', 's3:DeleteBucket', 's3:DeleteObject', 's3:DeleteObjectVersion', 'secretsmanager:DeleteSecret'],
    Resource: ['arn:aws:ec2:us-east-1:167217327520:volume/*', 'arn:aws:ecs:us-east-1:167217327520:*', 'arn:aws:events:us-east-1:167217327520:*', 'arn:aws:kms:us-east-1:167217327520:key/*', 'arn:aws:s3:::stokd-agent-*', 'arn:aws:s3:::stokd-agent-*/*', 'arn:aws:secretsmanager:us-east-1:167217327520:secret:stokd-agent-*'],
  }
  const initializationProof = {
    Sid: 'CannotResetVolumeInitializationProof', Effect: 'Deny',
    Action: ['ec2:CreateTags', 'ec2:DeleteTags'],
    Resource: 'arn:aws:ec2:us-east-1:167217327520:volume/*',
    Condition: { Null: { 'ec2:CreateAction': 'true' }, 'ForAnyValue:StringEquals': { 'aws:TagKeys': ['InitializationState'] } },
  }
  const bootstrapCustody = {
    Sid: 'CannotMutateBootstrapCustody', Effect: 'Deny',
    Action: ['cloudformation:CreateChangeSet', 'cloudformation:CreateStack', 'cloudformation:ExecuteChangeSet', 'cloudformation:UpdateStack'],
    Resource: 'arn:aws:cloudformation:us-east-1:167217327520:stack/stokd-agent-bootstrap/*',
  }
  const exact = { controlPolicy: policy(persistentDeletion, bootstrapCustody), runtimePolicy: policy(initializationProof) }
  assert.deepEqual(assertExactDeployCustodyDenials(exact), ['CannotMutateBootstrapCustody', 'CannotResetVolumeInitializationProof', 'PersistentDeletionIsImpossible'])
  assert.throws(() => assertExactDeployCustodyDenials({ ...exact, controlPolicy: policy({ ...persistentDeletion, Action: persistentDeletion.Action.slice(1) }, bootstrapCustody) }), /persistent-deletion denial changed/)
  assert.throws(() => assertExactDeployCustodyDenials({ ...exact, runtimePolicy: policy({ ...initializationProof, Condition: undefined }) }), /volume-initialization denial changed/)
  assert.throws(() => assertExactDeployCustodyDenials({ ...exact, controlPolicy: policy(persistentDeletion) }), /CannotMutateBootstrapCustody denial/)
})

test('effective IAM proof detects a forbidden action supplied only by an attached identity policy', () => {
  assert.throws(() => assertNoEffectiveModelOrExecutor({
    identityPolicies: [policy(allow('s3:GetObject')), policy(allow('bedrock:InvokeModel'))],
    boundaryPolicy: policy(allow('bedrock:*')),
  }), /effectively invoke bedrock:\*/)
})

test('effective IAM proof rejects boundary and identity global wildcard Allows', () => {
  assert.throws(() => assertNoEffectiveModelOrExecutor({
    identityPolicies: [policy(allow('s3:GetObject'))], boundaryPolicy: policy(allow('*')),
  }), /global wildcard Allow/)
  assert.throws(() => assertNoEffectiveModelOrExecutor({
    identityPolicies: [policy(allow('*'))], boundaryPolicy: policy(allow('s3:*')),
  }), /global wildcard Allow/)
})

test('effective IAM proof rejects NotAction because it cannot prove the bounded action set', () => {
  assert.throws(() => assertNoEffectiveModelOrExecutor({
    identityPolicies: [policy({ Effect: 'Allow', NotAction: 'iam:*', Resource: '*' })],
    boundaryPolicy: policy(allow('s3:*')),
  }), /uses NotAction/)
})

test('effective IAM proof respects an explicit boundary Deny over intersecting Allows', () => {
  assert.deepEqual(assertNoEffectiveModelOrExecutor({
    identityPolicies: [policy(allow('ecs:RunTask'))],
    boundaryPolicy: policy(allow('ecs:*'), deny('ecs:RunTask')),
  }), { modelInvokeAllowed: false, hiddenExecutorAllowed: false })
})

test('effective IAM proof covers Bedrock conversation/async and SageMaker endpoint variants', () => {
  for (const [action, boundary] of [
    ['bedrock:Converse', 'bedrock:*'],
    ['bedrock:StartAsyncInvoke', 'bedrock:*'],
    ['sagemaker:InvokeEndpointAsync', 'sagemaker:InvokeEndpoint*'],
  ]) {
    assert.throws(() => assertNoEffectiveModelOrExecutor({
      identityPolicies: [policy(allow(action))], boundaryPolicy: policy(allow(boundary)),
    }), /can effectively invoke/)
  }
})

test('conditional or resource-scoped Deny cannot prove execution authority absent', () => {
  const scopedDeny = { Effect: 'Deny', Action: 'bedrock:*', Resource: 'arn:aws:bedrock:us-east-1:167217327520:foundation-model/unrelated' }
  const conditionalDeny = { Effect: 'Deny', Action: 'ecs:RunTask', Resource: '*', Condition: { StringEquals: { 'aws:RequestedRegion': 'us-west-2' } } }
  assert.throws(() => assertNoEffectiveModelOrExecutor({
    identityPolicies: [policy(allow('bedrock:InvokeModel'), scopedDeny)], boundaryPolicy: policy(allow('bedrock:*')),
  }), /can effectively invoke bedrock:\*/)
  assert.throws(() => assertNoEffectiveModelOrExecutor({
    identityPolicies: [policy(allow('ecs:RunTask'), conditionalDeny)], boundaryPolicy: policy(allow('ecs:*')),
  }), /can effectively invoke ecs:RunTask/)
})

test('effective IAM proof covers async/sync/control execution variants and IAM question-mark globs', () => {
  for (const [action, boundary] of [
    ['states:StartSyncExecution', 'states:*'],
    ['lambda:InvokeAsync', 'lambda:*'],
    ['lambda:InvokeFunctionUrl', 'lambda:*'],
    ['ecs:ExecuteCommand', 'ecs:*'],
    ['lambda:InvokeFunctio?', 'lambda:*'],
    ['events:PutEvents', 'events:*'],
    ['sns:Publish', 'sns:*'],
    ['sqs:SendMessage', 'sqs:*'],
  ]) {
    assert.throws(() => assertNoEffectiveModelOrExecutor({
      identityPolicies: [policy(allow(action))], boundaryPolicy: policy(allow(boundary)),
    }), /can effectively invoke/)
  }
})

test('workload and deploy trust must remain one exact assumable principal', () => {
  const serviceTrust = policy({ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'ecs-tasks.amazonaws.com' } })
  assert.doesNotThrow(() => assertExactServiceTrust(serviceTrust, 'api-task', 'ecs-tasks.amazonaws.com'))
  assert.throws(() => assertExactServiceTrust(policy(...serviceTrust.Statement, { Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: '*' } }), 'api-task', 'ecs-tasks.amazonaws.com'), /one statement/)

  const deployTrust = policy({
    Effect: 'Allow', Action: 'sts:AssumeRoleWithWebIdentity',
    Principal: { Federated: 'arn:aws:iam::167217327520:oidc-provider/token.actions.githubusercontent.com' },
    Condition: { StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': ['repo:stokd-cloud/agent:environment:agent-validation', 'repo:stokd-cloud@264210261/agent@1354224769:environment:agent-validation'],
    } },
  })
  assert.doesNotThrow(() => assertExactDeployTrust(deployTrust))
  assert.throws(() => assertExactDeployTrust(policy({ ...deployTrust.Statement[0], Condition: { StringLike: { 'token.actions.githubusercontent.com:sub': 'repo:stokd-cloud/agent:*' } } })), /Expected values/)
})

test('effective provider-secret scope is exact and attached-policy expansion fails closed', () => {
  const runtimeArn = 'arn:aws:secretsmanager:us-east-1:167217327520:secret:stokd-agent-source-val12-runtime-abc123'
  const boundary = policy(allow('secretsmanager:GetSecretValue'))
  const exact = policy({ Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: runtimeArn })
  assert.deepEqual(assertEffectiveSecretReadScope({ identityPolicies: [exact], boundaryPolicy: boundary, expectedResources: [runtimeArn], roleName: 'api-execution' }), [runtimeArn])
  const providerArn = 'arn:aws:secretsmanager:us-east-1:167217327520:secret:stokd-agent-provider-openai-abc123'
  assert.throws(() => assertEffectiveSecretReadScope({ identityPolicies: [exact, policy({ Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: providerArn })], boundaryPolicy: boundary, expectedResources: [runtimeArn], roleName: 'api-execution' }), /effective secret-read scope changed/)
  assert.deepEqual(assertEffectiveSecretReadScope({ identityPolicies: [policy(deny('secretsmanager:*'))], boundaryPolicy: boundary, expectedResources: [], roleName: 'api-task' }), [])
  assert.throws(() => assertEffectiveSecretReadScope({ identityPolicies: [policy({ Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: providerArn })], boundaryPolicy: boundary, expectedResources: [], roleName: 'validation-deploy' }), /effective secret-read scope changed/)
})

test('effective SendCommand identity scope is the four fixed documents and tagged validation hosts only', () => {
  const documents = {
    Effect: 'Allow', Action: 'ssm:SendCommand', Resource: [
      'arn:aws:ssm:us-east-1:167217327520:document/stokd-agent-migrate-host-v1',
      'arn:aws:ssm:us-east-1:167217327520:document/stokd-agent-validation-seed-v1',
      'arn:aws:ssm:us-east-1:167217327520:document/stokd-agent-validation-backup-v1',
      'arn:aws:ssm:us-east-1:167217327520:document/stokd-agent-restore-host-v1',
    ],
  }
  const instances = {
    Effect: 'Allow', Action: 'ssm:SendCommand', Resource: 'arn:aws:ec2:us-east-1:167217327520:instance/*',
    Condition: { StringEquals: { 'ssm:resourceTag/Project': 'stokd-agent' }, StringLike: { 'ssm:resourceTag/Stage': ['source-val12', 'restore-val12'] } },
  }
  assert.doesNotThrow(() => assertExactSendCommandScope([policy(documents, instances)]))
  assert.throws(() => assertExactSendCommandScope([policy(documents, instances), policy({ Effect: 'Allow', Action: 'ssm:*', Resource: '*' })]), /exactly two/)
  assert.throws(() => assertExactSendCommandScope([policy({ ...documents, Resource: [...documents.Resource, 'arn:aws:ssm:us-east-1:167217327520:document/AWS-RunShellScript'] }, instances)]), /Expected values/)
  assert.throws(() => assertExactSendCommandScope([policy(documents, { ...instances, Condition: undefined })]), /Expected values/)
})

test('Mongo secret allowlist derives only from the exact three stage credential identities', () => {
  const secrets = {
    runtimeArn: 'arn:aws:secretsmanager:us-east-1:167217327520:secret:stokd-agent-source-val12-runtime-Ab12Cd',
    migrationArn: 'arn:aws:secretsmanager:us-east-1:167217327520:secret:stokd-agent-source-val12-migration-Ef34Gh',
    backupArn: 'arn:aws:secretsmanager:us-east-1:167217327520:secret:stokd-agent-source-val12-backup-Ij56Kl',
  }
  assert.deepEqual(exactStageSecretArns(secrets, 'source-val12'), [secrets.runtimeArn, secrets.migrationArn, secrets.backupArn])
  assert.throws(() => exactStageSecretArns({ ...secrets, providerArn: 'arn:aws:secretsmanager:us-east-1:167217327520:secret:stokd-agent-provider-openai-Mn78Op' }, 'source-val12'), /fields changed/)
  assert.throws(() => exactStageSecretArns({ ...secrets, runtimeArn: secrets.runtimeArn.replace('source-val12', 'restore-val12') }, 'source-val12'), /runtime ARN changed/)
})

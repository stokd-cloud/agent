import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { inspectAgentControlPlane } from '../../scripts/infra-control-plane-readback.mjs'
import { readVersionedEvidence } from '../../scripts/infra-evidence.mjs'
import { assertPhaseReceipt, phaseEvidenceKind, readBoundPhasePlan, work12Phases } from '../../scripts/infra-phase-control.mjs'
import { readRestoreLock } from '../../scripts/infra-restore-lock.mjs'
import { assertValidationFixtureReceipt } from '../../scripts/infra-validation-fixture.mjs'

const accountId = '167217327520'
const region = 'us-east-1'
const branchRef = 'refs/heads/project/d7f02e6-cloud-agents-mvp'
const fixtureSha256 = '92157692dc693ab50a63612b5e1c0c5e14188f185e79c406db1e9bceb2af7b25'

function aws(args) {
  const result = spawnSync('aws', [...args, '--region', region], { encoding: 'utf8', env: process.env })
  assert.equal(result.status, 0, `AWS readback failed closed: ${(result.stderr || result.stdout || '').trim()}`)
  return result.stdout.trim()
}
function json(raw, name) {
  try { return JSON.parse(raw) }
  catch { assert.fail(`${name} is not JSON`) }
}
function parameter(name) {
  const envelope = json(aws(['ssm', 'get-parameter', '--name', name, '--output', 'json']), name)
  assert.equal(typeof envelope?.Parameter?.Value, 'string', `${name} has no value`)
  return json(envelope.Parameter.Value, `${name} value`)
}
function exactKeys(value, keys, name) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${name} fields changed`)
}
function assertVersionId(value, name) {
  assert.match(value, /^[A-Za-z0-9-]{32,64}$/, `${name} is not an exact secret VersionId`)
}
function assertReadyObject(artifact, bucket, kmsKeyArn, versionId) {
  const head = json(aws(['s3api', 'head-object', '--bucket', bucket, '--key', artifact.objectKey, '--version-id', versionId, '--output', 'json']), 'ready artifact HEAD')
  assert.equal(head.VersionId, versionId)
  assert.equal(head.ContentLength, 32)
  assert.equal(head.SSEKMSKeyId, kmsKeyArn)
  assert.equal(head.Metadata?.sha256, fixtureSha256)
}
function assertCustody(value, stage) {
  assert.equal(value.artifactBucket, `stokd-agent-artifacts-${stage}-${accountId}`)
  assert.equal(value.backupBucket, `stokd-agent-backups-${stage}-${accountId}`)
  assert.match(value.databaseVolumeId, /^vol-[a-f0-9]{17}$/)
  assert.match(value.kmsKeyArn, /^arn:aws:kms:us-east-1:167217327520:key\/[a-f0-9-]{36}$/)
  assert.match(value.mongoInstanceId, /^i-[a-f0-9]{17}$/)
}
async function endpoint(stage, path, expectedStatus = 200) {
  const response = await fetch(`https://agent-${stage}.stokd.cloud${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  assert.equal(response.status, expectedStatus, `${stage}${path} returned ${response.status}`)
  return response.json()
}
async function commandEndpoint(stage, command, expectedStatus = 200) {
  const response = await fetch(`https://agent-${stage}.stokd.cloud/v1/commands`, {
    method: 'POST',
    headers: { accept: 'application/vnd.stokd-agent.v1+json', 'content-type': 'application/vnd.stokd-agent.v1+json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(20_000),
  })
  assert.equal(response.status, expectedStatus, `${stage} command returned ${response.status}`)
  return response.json()
}
function assertPhysical(value, stage, custody) {
  assert.equal(value.schemaVersion, '1.0')
  assert.equal(value.accountId, accountId)
  assert.equal(value.region, region)
  assert.equal(value.stage, stage)
  assert.match(value.sourceDigest, /^[a-f0-9]{40}$/)
  assert.match(value.planDigest, /^[a-f0-9]{64}$/)
  assert(Array.isArray(value.physicalResources) && value.physicalResources.length >= 8)
  assert.equal(value.custodyManifest.artifactBucket, custody.artifactBucket)
  assert.equal(value.custodyManifest.backupBucket, custody.backupBucket)
  assert.equal(value.custodyManifest.databaseVolumeId, custody.databaseVolumeId)
}
function assertTerraformHandoff(value, stage, manifest) {
  assert.equal(value.schemaVersion, '1.0')
  assert.equal(value.stage, stage)
  assert.deepEqual(value.importContract, { minimumTerraformVersion: '1.5.0', syntax: 'id', awsProviderMajor: 6 })
  assert.equal(value.selectedOwnershipModel, 'sst-native-resources-plus-cloudformation-stack-bridges')
  assert(Array.isArray(value.imports) && value.imports.length >= 40, `${stage} Terraform import inventory is incomplete`)
  assert.equal(new Set(value.imports.map(item => `${item.kind}\0${item.importId}`)).size, value.imports.length, `${stage} Terraform imports are not unique`)
  const imports = new Map(value.imports.map(item => [`${item.kind}\0${item.importId}`, item]))
  for (const required of [
    ['aws_vpc', manifest.vpc.id],
    ['aws_ecs_cluster', manifest.cluster.serviceName],
    ['aws_ecs_cluster_capacity_providers', manifest.cluster.serviceName],
    ['aws_ecs_service', `${manifest.cluster.serviceName}/${manifest.cluster.serviceName}`],
    ['aws_instance', manifest.mongo.instanceId],
    ['aws_ebs_volume', manifest.mongo.volumeId],
    ['aws_ssm_parameter', `/stokd-agent/${stage}/infrastructure-manifest/v1`],
    ['aws_cloudformation_stack', `stokd-agent-${stage}-credentials`],
  ]) assert(imports.has(`${required[0]}\0${required[1]}`), `${stage} Terraform inventory omitted ${required[0]} ${required[1]}`)
  assert.equal(imports.has(`aws_ecs_cluster\0${manifest.cluster.arn}`), false, `${stage} ECS cluster import incorrectly uses its ARN`)
  assert.equal(value.imports.filter(item => item.kind === 'aws_default_security_group').length, 1)
  assert(value.imports.some(item => item.kind === 'aws_appautoscaling_target' && item.importId === `ecs/service/${manifest.cluster.serviceName}/${manifest.cluster.serviceName}/ecs:service:DesiredCount`))
  assert.equal(value.imports.filter(item => item.kind === 'aws_service_discovery_service').length, 2)
  assert.equal(value.cloudFormationOwnership.some(owner => owner.stackName === `stokd-agent-${stage}-credentials` && owner.selectedModel === 'cloudformation-stack-bridge'), true)
  assert.deepEqual(value.sharedBootstrapOwnership, stage === 'source-val12'
    ? { emittedByStage: 'source-val12', importRequiredHere: true }
    : { emittedByStage: 'source-val12', importRequiredHere: false, stackName: 'stokd-agent-validation-bootstrap' })
  assert.equal(imports.has('aws_cloudformation_stack\0stokd-agent-validation-bootstrap'), stage === 'source-val12')
  assert(value.externalReferences.some(item => item.kind === 'aws_iam_openid_connect_provider' && item.owner === 'pre-existing-shared-account-infrastructure'))
  assert(value.externalReferences.some(item => item.kind === 'aws_route53_zone' && item.id === manifest.hostedZoneId && item.owner === 'pre-existing-stokd-cloud-dns'))
  assert(value.externalReferences.some(item => item.kind === 'aws_iam_service_linked_role' && item.owner === 'aws-managed-shared-account-service-role'))
  assert.equal(value.externalRetainedCustody.ownership, 'external-reference-only-never-import-or-reconfigure')
  assert.equal(value.externalRetainedCustody.passphraseParameters.length, 6)
  assert.equal(value.externalRetainedCustody.encryptedSecretObjects.length, 6)
  assert.equal(value.externalRetainedCustody.homeTerminals.length, 4)
  assert.equal(value.externalRetainedCustody.activeMarker.currentState, 'absent')
  assert(value.externalRetainedCustody.activeMarker.history.some(item => item.kind === 'version'))
  assert(value.externalRetainedCustody.activeMarker.history.some(item => item.kind === 'delete-marker' && item.isLatest))
  assert(value.externalRetainedCustody.retainedVersionInventory.some(item => item.key.startsWith('app/stokd-agent-')))
  assert(value.externalRetainedCustody.retainedVersionInventory.some(item => item.key.startsWith('bootstrap-init/work-1.2/')))
  assert.equal(value.excludedPhysicalResources.some(item => item.kind === 'aws_ebs_volume' && item.id === manifest.mongo.volumeId), false)
  assert(value.excludedPhysicalResources.some(item => item.kind === 'aws_ebs_volume' && item.reason === 'owned-by-aws_instance-root_block_device-delete_on_termination'))
  assert.equal(value.retainedCustody.filter(item => item.kind === 'aws_s3_bucket').length, 2)
  assert(value.retainedCustody.some(item => item.kind === 'aws_kms_key' && item.importId === manifest.custody.kmsKeyArn.split('/').at(-1)))
  assert.deepEqual(value.behavioralContracts, {
    orderedValidationPhases: work12Phases.map(item => item.phase),
    restoreAdmissionLockParameter: '/stokd-agent/validation/work-1.2/restore-admission-lock/v1',
    apiDesiredCount: 1, apiCapacityBounds: [1, 1], apiAutoscalingPolicies: false, restoreStageMode: 'restored_observation',
    privateNatGateways: 0, cloudModelInvokeAllowed: false,
  })
  assert.deepEqual(value.stateTransition.order, [
    'author-target-terraform-resources',
    'import-each-selected-remote-object-once',
    'prove-no-op-plan-and-retained-custody',
    'retire-sst-state-without-cloud-deletes',
  ])
}
function assertFixture(value, stage, artifactBucket, currentKmsKeyArn) {
  return assertValidationFixtureReceipt({ value, stage, artifactBucket, currentKmsKeyArn })
  /* c8 ignore start -- retained only as a reviewable historical shape while Work 1.2 closes */
  exactKeys(value, ['schemaVersion', 'operationId', 'payloadSha256', 'payloadByteLength', 'persistedAt', 'semanticStateSha256', 'identity', 'history', 'pending', 'priorExecution', 'artifacts', 'recoveryMode', 'dispatchIntentCount', 'executorLaunchCount', 'redispatchCount'], 'fixture')
  assert.equal(value.schemaVersion, '1.0')
  assert.equal(value.operationId, 'valop_work12_durable_fixture')
  assert.equal(value.payloadSha256, fixtureSha256)
  assert.equal(value.payloadByteLength, 32)
  assert.match(value.semanticStateSha256, /^[a-f0-9]{64}$/)
  assert.equal(new Date(value.persistedAt).toISOString(), value.persistedAt)
  exactKeys(value.identity, ['ownerSubject', 'agentId', 'normalizedName', 'profileRevision', 'profileSha256'], 'fixture identity')
  assert.match(value.identity.ownerSubject, /^own_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.identity.agentId, /^agt_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.identity.normalizedName, /^validation-[a-f0-9]{24}$/)
  assert.equal(value.identity.profileRevision, 1)
  assert.match(value.identity.profileSha256, /^[a-f0-9]{64}$/)
  exactKeys(value.history, ['conversationId', 'eventId', 'eventCount', 'latestSequence', 'memoryId', 'memoryRevision', 'memorySha256'], 'fixture history')
  assert.match(value.history.conversationId, /^cnv_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.history.eventId, /^evt_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.history.memoryId, /^mem_[A-Za-z0-9_-]{8,128}$/)
  assert.equal(value.history.eventCount, 1)
  assert.equal(value.history.latestSequence, 1)
  assert.equal(value.history.memoryRevision, 1)
  assert.match(value.history.memorySha256, /^[a-f0-9]{64}$/)
  exactKeys(value.pending, ['wakeId', 'attemptId', 'workId', 'approvalId', 'wakeState', 'attemptState', 'workState', 'approvalState', 'dispatchAllowed'], 'fixture pending')
  assert.match(value.pending.wakeId, /^wak_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.pending.attemptId, /^atm_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.pending.workId, /^wrk_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.pending.approvalId, /^apr_[A-Za-z0-9_-]{8,128}$/)
  assert.deepEqual({ wake: value.pending.wakeState, attempt: value.pending.attemptState, work: value.pending.workState, approval: value.pending.approvalState }, { wake: 'queued', attempt: 'awaiting_approval', work: 'pending', approval: 'pending' })
  assert.equal(value.pending.dispatchAllowed, stage === 'source-val12')
  exactKeys(value.priorExecution, ['workId', 'intentId', 'workState', 'intentState', 'launchAuditId', 'launchEventType'], 'fixture prior execution')
  assert.match(value.priorExecution.workId, /^wrk_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.priorExecution.intentId, /^din_[A-Za-z0-9_-]{8,128}$/)
  assert.match(value.priorExecution.launchAuditId, /^aud_[A-Za-z0-9_-]{8,128}$/)
  assert.deepEqual({ work: value.priorExecution.workState, intent: value.priorExecution.intentState, event: value.priorExecution.launchEventType }, { work: 'succeeded', intent: 'accepted', event: 'executor.launch' })
  assert.equal(value.recoveryMode, stage === 'source-val12' ? 'live' : 'restored_observation')
  assert.equal(value.dispatchIntentCount, 1)
  assert.equal(value.executorLaunchCount, 1)
  assert.equal(value.redispatchCount, 0)
  assert.equal(value.artifacts.length, 2)
  const retained = value.artifacts.find(artifact => artifact.kind === 'retained')
  const absent = value.artifacts.find(artifact => artifact.kind === 'absent_after_backup')
  assert(retained && absent)
  for (const artifact of [retained, absent]) {
    assert.match(artifact.artifactId, /^art_[A-Za-z0-9_-]{8,128}$/)
    assert.match(artifact.versionId, /^arv_[A-Za-z0-9_-]{8,128}$/)
    assert.match(artifact.sourceKmsKeyId, /^arn:aws:kms:us-east-1:167217327520:key\/[a-f0-9-]{36}$/)
    assert.match(artifact.currentKmsKeyId, /^arn:aws:kms:us-east-1:167217327520:key\/[a-f0-9-]{36}$/)
  }
  const sourceBucket = `stokd-agent-artifacts-source-val12-${accountId}`
  for (const artifact of [retained, absent]) {
    assert.equal(artifact.sha256, fixtureSha256)
    assert.equal(artifact.byteLength, 32)
    assert.equal(artifact.sourceBucket, sourceBucket)
    assert.match(artifact.sourceS3VersionId, /^[A-Za-z0-9._=+\/-]{1,1024}$/)
    assert.match(artifact.currentS3VersionId, /^[A-Za-z0-9._=+\/-]{1,1024}$/)
  }
  assert.equal(retained.state, 'ready')
  assert.equal(retained.currentBucket, artifactBucket)
  assert.equal(retained.currentKmsKeyId, currentKmsKeyArn)
  assert.equal(retained.objectKey, 'agents/validation/valop_work12_durable_fixture/retained.bin')
  assert.equal(retained.versionMapped, stage === 'restore-val12')
  assert.equal(absent.objectKey, 'agents/validation/valop_work12_durable_fixture/absent-after-backup.bin')
  assert.equal(absent.currentBucket, sourceBucket)
  assert.equal(absent.currentKmsKeyId, absent.sourceKmsKeyId)
  assert.equal(absent.versionMapped, false)
  assert.equal(absent.state, stage === 'source-val12' ? 'ready' : 'degraded_missing_object')
  assert.equal(absent.degradedReason, stage === 'restore-val12' ? 'missing_version' : undefined)
  assert.equal(absent.degradationProvenance, stage === 'restore-val12' ? 'work12_injected_missing_version_after_exact_source_head' : undefined)
  return { retained, absent }
  /* c8 ignore stop */
}

test('VAL-OPS-001/003 accumulated isolated AWS lifecycle evidence is complete', { timeout: 600_000 }, async () => {
  assert.equal(process.env.AGENT_RUN_CLOUD_VALIDATION, '1', 'real cloud validation must be explicitly selected')
  assert.equal(process.env.GITHUB_REPOSITORY, 'stokd-cloud/agent', 'validation must run in the exact repository')
  assert.equal(process.env.GITHUB_REF, branchRef, 'validation must run from the reviewed project branch')
  assert.equal(process.env.AGENT_GITHUB_ENVIRONMENT, 'agent-validation', 'validation must run through the protected GitHub environment')
  assert.equal(process.env.AWS_REGION, region)
  assert.equal(process.env.AWS_DEFAULT_REGION, region)
  assert.match(process.env.VALIDATION_RUN_ID ?? '', /^github-[1-9][0-9]{0,19}$/)
  assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/)

  const caller = json(aws(['sts', 'get-caller-identity', '--output', 'json']), 'caller identity')
  assert.equal(caller.Account, accountId)
  assert.match(caller.Arn, /^arn:aws:sts::167217327520:assumed-role\/stokd-agent-validation-deploy\/agent-validation-[A-Za-z0-9+=,.@_-]{1,64}$/)
  assert(!caller.Arn.endsWith(':root'), 'account root is forbidden')

  const sourceManifest = parameter('/stokd-agent/source-val12/infrastructure-manifest/v1')
  const restoreManifest = parameter('/stokd-agent/restore-val12/infrastructure-manifest/v1')
  assert.equal(sourceManifest.sourceDigest, process.env.GITHUB_SHA)
  assert.equal(restoreManifest.sourceDigest, process.env.GITHUB_SHA)
  let predecessor
  let priorCompletedAt = 0
  for (const [index, phase] of work12Phases.entries()) {
    const phaseManifest = phase.stage === 'source-val12' ? sourceManifest : restoreManifest
    const item = readVersionedEvidence({ aws, stage: phase.stage, kind: phaseEvidenceKind(phase.phase), kmsKeyArn: phaseManifest.custody.kmsKeyArn })
    const plan = readBoundPhasePlan({ aws, phase: phase.phase, validationRunId: process.env.VALIDATION_RUN_ID, sourceDigest: process.env.GITHUB_SHA, predecessorPointer: predecessor?.pointer })
    assertPhaseReceipt(item.value, { ...phase, index, validationRunId: process.env.VALIDATION_RUN_ID, sourceDigest: process.env.GITHUB_SHA, planDigest: plan.planDigest }, predecessor?.pointer)
    const completedAt = new Date(item.value.completedAt).getTime()
    assert(completedAt >= priorCompletedAt, `${phase.phase} completed before its predecessor`)
    priorCompletedAt = completedAt
    predecessor = item
  }
  assert.equal(readRestoreLock(aws), undefined, 'verified restore left its cloud admission lock active')
  const sourceEvidence = readVersionedEvidence({ aws, stage: 'source-val12', kind: 'evidence', kmsKeyArn: sourceManifest.custody.kmsKeyArn })
  const restoreEvidence = readVersionedEvidence({ aws, stage: 'restore-val12', kind: 'evidence', kmsKeyArn: restoreManifest.custody.kmsKeyArn })
  const sourceFixture = readVersionedEvidence({ aws, stage: 'source-val12', kind: 'fixture', kmsKeyArn: sourceManifest.custody.kmsKeyArn })
  const restoreFixture = readVersionedEvidence({ aws, stage: 'restore-val12', kind: 'fixture', kmsKeyArn: restoreManifest.custody.kmsKeyArn })
  const sourcePhysicalEvidence = readVersionedEvidence({ aws, stage: 'source-val12', kind: 'physical-resources', kmsKeyArn: sourceManifest.custody.kmsKeyArn })
  const restorePhysicalEvidence = readVersionedEvidence({ aws, stage: 'restore-val12', kind: 'physical-resources', kmsKeyArn: restoreManifest.custody.kmsKeyArn })
  const source = sourceEvidence.value
  const restore = restoreEvidence.value
  const sourceFixtureEvidence = sourceFixture.value
  const restoreFixtureEvidence = restoreFixture.value
  const sourcePhysical = sourcePhysicalEvidence.value
  const restorePhysical = restorePhysicalEvidence.value

  for (const item of [sourceEvidence, restoreEvidence, sourceFixture, restoreFixture, sourcePhysicalEvidence, restorePhysicalEvidence]) {
    assert.equal(item.pointer.kind, 'versioned-s3-json')
    assert.match(item.pointer.versionId, /^[A-Za-z0-9._=+\/-]{1,1024}$/)
    assert.match(item.pointer.sha256, /^[a-f0-9]{64}$/)
  }

  for (const [stage, evidence, manifest] of [['source-val12', source, sourceManifest], ['restore-val12', restore, restoreManifest]]) {
    assert.equal(evidence.schemaVersion, '1.0')
    assert.equal(evidence.stage, stage)
    assert.equal(evidence.destructivePlanRefused, true)
    assert.match(evidence.sourceDigest, /^[a-f0-9]{40}$/)
    assert.match(evidence.planDigest, /^[a-f0-9]{64}$/)
    assertCustody(evidence.resourceIds, stage)
    assert.equal(manifest.mongo.host, `mongo-${stage}.sst:27017`)
    assert.equal(manifest.vpc.cloudmapNamespaceName, 'sst')
    assert.deepEqual(manifest.vpc.natGatewayIds, [])
    assert.deepEqual(manifest.vpc.elasticIpIds, [])
    assert.equal(manifest.recoveryMode, stage === 'source-val12' ? 'active' : 'restored_observation')
    assert.equal(evidence.controlPlane.privateInternetEgressDenied, true)
    assert.equal(evidence.controlPlane.stokdServiceEgressDenied, true)
    assert.equal(evidence.controlPlane.cloudModelInvokeAllowed, false)
    assertTerraformHandoff(evidence.controlPlane.terraformMigrationInventory, stage, manifest)
    assert.deepEqual(Object.keys(evidence.redeployProofs ?? {}).sort(), ['api', 'data'])
    for (const proof of Object.values(evidence.redeployProofs)) {
      assert.equal(proof.retainedCustodyUnchanged, true)
      assert.equal(proof.fixturePreserved, true)
      assert.match(proof.sourceDigest, /^[a-f0-9]{40}$/)
      assert.match(proof.planDigest, /^[a-f0-9]{64}$/)
      assert.match(proof.taskDefinitionArn, /^arn:aws:ecs:us-east-1:167217327520:task-definition\/stokd-agent-api-(source|restore)-val12:\d+$/)
    }
  }

  assertPhysical(sourcePhysical, 'source-val12', source.resourceIds)
  assertPhysical(restorePhysical, 'restore-val12', restore.resourceIds)
  for (const key of ['artifactBucket', 'backupBucket', 'databaseVolumeId', 'kmsKeyArn', 'mongoInstanceId']) assert.notEqual(source.resourceIds[key], restore.resourceIds[key], `${key} must be stage-isolated`)

  assert.equal(source.fixture.semanticStateSha256, sourceFixtureEvidence.semanticStateSha256)
  assert.equal(restore.fixture.semanticStateSha256, restoreFixtureEvidence.semanticStateSha256)
  const sourceArtifacts = assertFixture(sourceFixtureEvidence, 'source-val12', source.resourceIds.artifactBucket, source.resourceIds.kmsKeyArn)
  const restoreArtifacts = assertFixture(restoreFixtureEvidence, 'restore-val12', restore.resourceIds.artifactBucket, restore.resourceIds.kmsKeyArn)
  assert.equal(restoreFixtureEvidence.semanticStateSha256, sourceFixtureEvidence.semanticStateSha256)
  assert.deepEqual(restoreFixtureEvidence.identity, sourceFixtureEvidence.identity)
  assert.deepEqual(restoreFixtureEvidence.history, sourceFixtureEvidence.history)
  assert.deepEqual(restoreFixtureEvidence.priorExecution, sourceFixtureEvidence.priorExecution)
  assert.deepEqual({ ...restoreFixtureEvidence.pending, dispatchAllowed: true }, sourceFixtureEvidence.pending)
  assert.equal(sourceArtifacts.retained.sourceBucket, source.resourceIds.artifactBucket)
  assert.equal(sourceArtifacts.retained.currentBucket, source.resourceIds.artifactBucket)
  assert.equal(restoreArtifacts.retained.sourceBucket, source.resourceIds.artifactBucket)
  assert.equal(restoreArtifacts.retained.currentBucket, restore.resourceIds.artifactBucket)
  assert.notEqual(restoreArtifacts.retained.currentS3VersionId, restoreArtifacts.retained.sourceS3VersionId)
  assert.equal(restoreArtifacts.absent.sourceBucket, sourceArtifacts.absent.sourceBucket)
  assert.equal(restoreArtifacts.absent.currentS3VersionId, sourceArtifacts.absent.currentS3VersionId)
  assertReadyObject(sourceArtifacts.retained, source.resourceIds.artifactBucket, source.resourceIds.kmsKeyArn, sourceArtifacts.retained.currentS3VersionId)
  assertReadyObject(sourceArtifacts.absent, source.resourceIds.artifactBucket, source.resourceIds.kmsKeyArn, sourceArtifacts.absent.currentS3VersionId)
  assertReadyObject(restoreArtifacts.retained, restore.resourceIds.artifactBucket, restore.resourceIds.kmsKeyArn, restoreArtifacts.retained.currentS3VersionId)
  exactKeys(source.backup.sourceSecretVersionIds, ['runtime', 'migration', 'backup'], 'source secret versions')
  for (const [kind, value] of Object.entries(source.backup.sourceSecretVersionIds)) assertVersionId(value, `source ${kind}`)
  assert.equal(source.backup.archiveCustody.bucket, source.resourceIds.backupBucket)
  assert.equal(source.backup.manifestCustody.bucket, source.resourceIds.backupBucket)
  assert.match(source.backup.archiveCustody.versionId, /^[A-Za-z0-9._=+\/-]{1,1024}$/)
  assert.match(source.backup.manifestCustody.versionId, /^[A-Za-z0-9._=+\/-]{1,1024}$/)
  assert.equal(source.backup.manifestSha256, source.backup.manifestCustody.sha256)

  assert.equal(restore.restore.recoveryMode, 'restored_observation')
  assert.equal(restore.restore.redispatchCount, 0)
  assert.equal(restore.restore.dispatchIntentCountBefore, restore.restore.dispatchIntentCountAfter)
  assert.deepEqual(restore.restore.dispatchBoundaryBefore, { accepted: 1, launched: 1 })
  assert.deepEqual(restore.restore.dispatchBoundaryAfter, restore.restore.dispatchBoundaryBefore)
  assert.equal(restore.restore.readyObjectVersions, 3)
  assert.equal(restore.restore.degradedObjectVersions, 1)
  assert.deepEqual(restore.restore.degraded, [{
    objectKey: sourceArtifacts.absent.objectKey, versionId: sourceArtifacts.absent.sourceS3VersionId, reason: 'missing_version',
    provenance: 'work12_injected_missing_version_after_exact_source_head',
  }])
  exactKeys(restore.restore.targetSecretVersionIds, ['runtime', 'migration', 'backup'], 'target secret versions')
  for (const [kind, value] of Object.entries(restore.restore.targetSecretVersionIds)) assertVersionId(value, `target ${kind}`)
  const denialKeys = new Set(restore.restore.archivedCredentialProbeResults.map(value => `${value.origin}/${value.kind}/${value.rejected}`))
  assert.deepEqual(denialKeys, new Set(['source_archive/runtime/true', 'source_archive/migration/true', 'source_archive/backup/true', 'target_pre_restore/runtime/true', 'target_pre_restore/migration/true', 'target_pre_restore/backup/true']))
  assert.equal(restore.sourceBackup.manifestVersionId, source.backup.manifestCustody.versionId)
  assert.equal(restore.sourceBackup.archiveVersionId, source.backup.archiveCustody.versionId)
  assert.equal(restore.fixture.payloadSha256, fixtureSha256)

  const [sourceHealth, restoreHealth, sourceApiFixture, restoreApiFixture] = await Promise.all([
    endpoint('source-val12', '/health'),
    endpoint('restore-val12', '/health'),
    endpoint('source-val12', '/v1/validation-fixture'),
    endpoint('restore-val12', '/v1/validation-fixture'),
  ])
  assert.equal(sourceHealth.storage.serverVersion, '7.0.29')
  assert.equal(sourceHealth.recoveryMode, 'active')
  assert.equal(restoreHealth.storage.serverVersion, '7.0.29')
  assert.equal(restoreHealth.recoveryMode, 'restored_observation')
  assert.deepEqual(sourceApiFixture.fixture, sourceFixtureEvidence)
  assert.deepEqual(restoreApiFixture.fixture, restoreFixtureEvidence)

  const common = { schemaVersion: '1.0', agentId: 'agt_validation01', conversationId: 'cnv_validation01' }
  const commands = [
    { ...common, commandId: 'cmd_validation01', commandType: 'conversation.message.admit', expectedRevision: 0, payload: { text: 'bounded cloud validation', idempotencyKey: 'work-1.2' } },
    { ...common, commandId: 'cmd_validation02', commandType: 'wake.status.get', payload: { wakeId: 'wak_validation01' } },
    { ...common, commandId: 'cmd_validation03', commandType: 'wake.cancel', expectedRevision: 0, payload: { wakeId: 'wak_validation01', reason: 'bounded validation' } },
    { ...common, commandId: 'cmd_validation04', commandType: 'approval.respond', expectedRevision: 0, payload: { approvalId: 'apr_validation01', actionHash: 'sha256:bounded', decision: 'denied' } },
    { ...common, commandId: 'cmd_validation05', commandType: 'artifact.reference.get', payload: { artifactId: 'art_validation01' } },
  ]
  for (const command of commands) {
    const result = await commandEndpoint('source-val12', command)
    assert.equal(result.schemaVersion, '1.0')
    assert.equal(result.commandId, command.commandId)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'unsupported_capability')
    assert.equal(result.error.exitCode, 7)
  }
  const locked = await commandEndpoint('restore-val12', commands[0], 423)
  assert.equal(locked.error, 'restored_observation_only')
  const stream = await fetch('https://agent-source-val12.stokd.cloud/v1/events?agentId=agt_validation01&conversationId=cnv_validation01', { signal: AbortSignal.timeout(20_000) })
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get('content-type') ?? '', /^text\/event-stream/)
  assert.equal(await stream.text(), '')

  const [sourceControlPlane, restoreControlPlane] = await Promise.all([
    inspectAgentControlPlane({ aws, manifest: sourceManifest }),
    inspectAgentControlPlane({ aws, manifest: restoreManifest }),
  ])
  for (const [stage, manifest, fresh, recorded] of [
    ['source-val12', sourceManifest, sourceControlPlane, source.controlPlane],
    ['restore-val12', restoreManifest, restoreControlPlane, restore.controlPlane],
  ]) {
    assert.deepEqual(fresh.endpointIds, recorded.endpointIds)
    assert.deepEqual(fresh.securityGroupIds, recorded.securityGroupIds)
    assert.deepEqual(fresh.privateRouteTableIds, recorded.privateRouteTableIds)
    assert.deepEqual(fresh.publicRouteTableIds, recorded.publicRouteTableIds)
    assert.equal(fresh.privateInternetEgressDenied, true)
    assert.equal(fresh.stokdServiceEgressDenied, true)
    assert.equal(fresh.cloudModelInvokeAllowed, false)
    assertTerraformHandoff(fresh.terraformMigrationInventory, stage, manifest)
    assert.deepEqual(fresh.terraformMigrationInventory.imports, recorded.terraformMigrationInventory.imports)
    assert.deepEqual(fresh.terraformMigrationInventory.cloudFormationOwnership, recorded.terraformMigrationInventory.cloudFormationOwnership)
    assert.deepEqual(fresh.terraformMigrationInventory.sharedBootstrapOwnership, recorded.terraformMigrationInventory.sharedBootstrapOwnership)
    assert.deepEqual(fresh.terraformMigrationInventory.parameterOwnership, recorded.terraformMigrationInventory.parameterOwnership)
    assert.deepEqual(fresh.terraformMigrationInventory.externalReferences, recorded.terraformMigrationInventory.externalReferences)
    assert.deepEqual(fresh.terraformMigrationInventory.externalRetainedCustody, recorded.terraformMigrationInventory.externalRetainedCustody)
    assert.deepEqual(fresh.terraformMigrationInventory.excludedPhysicalResources, recorded.terraformMigrationInventory.excludedPhysicalResources)
    assert.deepEqual(fresh.terraformMigrationInventory.retainedCustody, recorded.terraformMigrationInventory.retainedCustody)
    assert.deepEqual(fresh.terraformMigrationInventory.behavioralContracts, recorded.terraformMigrationInventory.behavioralContracts)
    assert.deepEqual(fresh.terraformMigrationInventory.stateTransition, recorded.terraformMigrationInventory.stateTransition)
  }

  for (const manifest of [sourceManifest, restoreManifest]) {
    const services = json(aws(['ecs', 'describe-services', '--cluster', manifest.cluster.arn, '--services', manifest.cluster.serviceArn, '--output', 'json']), 'ECS service')
    assert.equal(services.failures.length, 0)
    assert.equal(services.services.length, 1)
    assert.equal(services.services[0].desiredCount, 1)
    assert.equal(services.services[0].runningCount, 1)
  }
})

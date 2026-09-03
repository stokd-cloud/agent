/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    if (!['source-val12', 'restore-val12'].includes(input.stage)) throw new Error(`unsupported Agent validation stage: ${input.stage}`)
    return {
      name: 'stokd-agent-data',
      home: 'aws',
      version: '3.19.3',
      removal: 'remove',
      protect: false,
      providers: {
        aws: {
          region: 'us-east-1',
          defaultTags: { tags: { Project: 'stokd-agent', Stage: input.stage, ManagedBy: 'sst-3.19.3' } },
        },
      },
    }
  },
  async run() {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const { assertSstDeploymentIdentity } = await import('../shared/deployment-guard')
    const {
      AGENT_AWS_ACCOUNT_ID, AGENT_AWS_REGION, AGENT_INFRA_MANIFEST_VERSION,
      artifactBucketName, backupBucketName, infrastructureManifestParameter, resolveAgentStage,
    } = await import('../shared/constants')
    const { agentTags, ec2TrustPolicy, workloadBoundaryArn } = await import('../shared/policy')
    const here = resolve(fileURLToPath(new URL('.', import.meta.url)))
    const runtime = (name: string) => readFileSync(resolve(here, '..', 'runtime', name), 'utf8')
    const exactImage = (name: string): string => {
      const value = process.env[name]
      if (!value || !/^167217327520\.dkr\.ecr\.us-east-1\.amazonaws\.com\/stokd-agent-runtime@sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be an exact private ECR digest`)
      return value
    }
    const identity = resolveAgentStage($app.stage)
    await assertSstDeploymentIdentity(identity.stage)
    const tags = agentTags(identity.stage, 'persistent')
    const runtimeTags = agentTags(identity.stage, 'runtime')
    const mongoImage = exactImage('AGENT_MONGO_IMAGE')
    const maintenanceImage = exactImage('AGENT_MAINTENANCE_IMAGE')
    const sourceDigest = process.env.AGENT_SOURCE_DIGEST
    if (!sourceDigest || !/^[a-f0-9]{40}$/.test(sourceDigest)) throw new Error('AGENT_SOURCE_DIGEST must be the exact source commit')

    const vpc = new sst.aws.Vpc('AgentVpc', {
      az: ['us-east-1a', 'us-east-1b'],
      transform: {
        vpc: { enableDnsHostnames: true, enableDnsSupport: true, tags: runtimeTags },
        internetGateway: { tags: runtimeTags },
        securityGroup: { ingress: [], egress: [], tags: runtimeTags },
        publicSubnet: args => { args.tags = { ...runtimeTags, Network: 'public-alb' } },
        privateSubnet: args => { args.tags = { ...runtimeTags, Network: 'private-endpoint-only' } },
        publicRouteTable: { tags: runtimeTags },
        privateRouteTable: { tags: runtimeTags },
      },
    })

    const endpointSecurityGroup = new aws.ec2.SecurityGroup('AgentEndpointSecurityGroup', {
      name: `stokd-agent-endpoints-${identity.stage}`,
      description: 'TLS only from Agent workloads to private AWS endpoints',
      vpcId: vpc.id,
      ingress: [], egress: [],
      tags: runtimeTags,
    })
    const mongoSecurityGroup = new aws.ec2.SecurityGroup('AgentMongoSecurityGroup', {
      name: `stokd-agent-mongo-${identity.stage}`,
      description: 'MongoDB only from the exact Agent API security group',
      vpcId: vpc.id,
      ingress: [], egress: [],
      tags: runtimeTags,
    })
    const apiSecurityGroup = new aws.ec2.SecurityGroup('AgentApiSecurityGroup', {
      name: `stokd-agent-api-${identity.stage}`,
      description: 'Private Fargate API tasks',
      vpcId: vpc.id,
      ingress: [], egress: [],
      tags: runtimeTags,
    })

    new aws.ec2.SecurityGroupRule('EndpointIngressFromMongo', { type: 'ingress', protocol: 'tcp', fromPort: 443, toPort: 443, securityGroupId: endpointSecurityGroup.id, sourceSecurityGroupId: mongoSecurityGroup.id })
    new aws.ec2.SecurityGroupRule('EndpointIngressFromApi', { type: 'ingress', protocol: 'tcp', fromPort: 443, toPort: 443, securityGroupId: endpointSecurityGroup.id, sourceSecurityGroupId: apiSecurityGroup.id })
    new aws.ec2.SecurityGroupRule('MongoIngressFromApi', { type: 'ingress', protocol: 'tcp', fromPort: 27017, toPort: 27017, securityGroupId: mongoSecurityGroup.id, sourceSecurityGroupId: apiSecurityGroup.id })
    new aws.ec2.SecurityGroupRule('MongoEndpointEgress', { type: 'egress', protocol: 'tcp', fromPort: 443, toPort: 443, securityGroupId: mongoSecurityGroup.id, sourceSecurityGroupId: endpointSecurityGroup.id })
    new aws.ec2.SecurityGroupRule('ApiEndpointEgress', { type: 'egress', protocol: 'tcp', fromPort: 443, toPort: 443, securityGroupId: apiSecurityGroup.id, sourceSecurityGroupId: endpointSecurityGroup.id })
    new aws.ec2.SecurityGroupRule('ApiMongoEgress', { type: 'egress', protocol: 'tcp', fromPort: 27017, toPort: 27017, securityGroupId: apiSecurityGroup.id, sourceSecurityGroupId: mongoSecurityGroup.id })
    for (const [name, group] of [['Mongo', mongoSecurityGroup], ['Api', apiSecurityGroup]] as const) {
      new aws.ec2.SecurityGroupRule(`${name}DnsUdp`, { type: 'egress', protocol: 'udp', fromPort: 53, toPort: 53, cidrBlocks: [vpc.nodes.vpc.cidrBlock], securityGroupId: group.id })
      new aws.ec2.SecurityGroupRule(`${name}DnsTcp`, { type: 'egress', protocol: 'tcp', fromPort: 53, toPort: 53, cidrBlocks: [vpc.nodes.vpc.cidrBlock], securityGroupId: group.id })
    }

    const interfaceServices = ['ecr.api', 'ecr.dkr', 'logs', 'secretsmanager', 'kms', 'ssm', 'ssmmessages', 'ec2messages', 'ec2', 'ecs', 'ecs-agent', 'ecs-telemetry'] as const
    const endpoints = interfaceServices.map(service => new aws.ec2.VpcEndpoint(`AgentEndpoint${service.replaceAll('.', '')}`, {
      vpcId: vpc.id,
      serviceName: `com.amazonaws.${AGENT_AWS_REGION}.${service}`,
      vpcEndpointType: 'Interface',
      privateDnsEnabled: true,
      subnetIds: vpc.privateSubnets,
      securityGroupIds: [endpointSecurityGroup.id],
      tags: runtimeTags,
    }))
    const s3Endpoint = new aws.ec2.VpcEndpoint('AgentS3Endpoint', {
      vpcId: vpc.id,
      serviceName: `com.amazonaws.${AGENT_AWS_REGION}.s3`,
      vpcEndpointType: 'Gateway',
      routeTableIds: vpc.nodes.privateRouteTables.apply(tables => tables.map(table => table.id)),
      tags: runtimeTags,
    })
    const s3PrefixList = aws.ec2.getPrefixListOutput({ name: `com.amazonaws.${AGENT_AWS_REGION}.s3` })
    new aws.ec2.SecurityGroupRule('MongoS3EndpointEgress', { type: 'egress', protocol: 'tcp', fromPort: 443, toPort: 443, prefixListIds: [s3PrefixList.id], securityGroupId: mongoSecurityGroup.id })
    new aws.ec2.SecurityGroupRule('ApiS3EndpointEgress', { type: 'egress', protocol: 'tcp', fromPort: 443, toPort: 443, prefixListIds: [s3PrefixList.id], securityGroupId: apiSecurityGroup.id })

    const mongoRoleName = `stokd-agent-workload-mongo-${identity.stage}`
    const mongoRole = new aws.iam.Role('AgentMongoRole', {
      name: mongoRoleName,
      assumeRolePolicy: ec2TrustPolicy(),
      permissionsBoundary: workloadBoundaryArn,
      tags: runtimeTags,
    })

    const keyPolicy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'BoundedDeployAdministration', Effect: 'Allow', Principal: '*', Resource: '*',
          Action: ['kms:CreateAlias', 'kms:DescribeKey', 'kms:EnableKeyRotation', 'kms:GetKeyPolicy', 'kms:GetKeyRotationStatus', 'kms:ListResourceTags', 'kms:PutKeyPolicy', 'kms:TagResource', 'kms:UntagResource', 'kms:UpdateAlias'],
          Condition: { StringEquals: { 'aws:PrincipalArn': `arn:aws:iam::${AGENT_AWS_ACCOUNT_ID}:role/stokd-agent-validation-deploy` } },
        },
        {
          Sid: 'BoundedDeployServiceUse', Effect: 'Allow', Principal: '*', Resource: '*',
          Action: ['kms:Decrypt', 'kms:DescribeKey', 'kms:Encrypt', 'kms:GenerateDataKey', 'kms:GenerateDataKeyWithoutPlaintext', 'kms:ReEncrypt*'],
          Condition: {
            StringEquals: { 'aws:PrincipalArn': `arn:aws:iam::${AGENT_AWS_ACCOUNT_ID}:role/stokd-agent-validation-deploy` },
            StringLike: { 'kms:ViaService': [`ec2.${AGENT_AWS_REGION}.amazonaws.com`, `secretsmanager.${AGENT_AWS_REGION}.amazonaws.com`] },
          },
        },
        {
          Sid: 'BoundedDeployEvidenceS3Use', Effect: 'Allow', Principal: '*', Resource: '*',
          Action: ['kms:Decrypt', 'kms:DescribeKey', 'kms:Encrypt', 'kms:GenerateDataKey', 'kms:GenerateDataKeyWithoutPlaintext', 'kms:ReEncrypt*'],
          Condition: {
            StringEquals: {
              'aws:PrincipalArn': `arn:aws:iam::${AGENT_AWS_ACCOUNT_ID}:role/stokd-agent-validation-deploy`,
              'kms:ViaService': `s3.${AGENT_AWS_REGION}.amazonaws.com`,
            },
            StringLike: {
              'kms:EncryptionContext:aws:s3:arn': `arn:aws:s3:::${artifactBucketName(identity.stage)}/validation/work-1.2/${identity.stage}/*`,
            },
          },
        },
        {
          Sid: 'BoundedDeployServiceGrant', Effect: 'Allow', Principal: '*', Resource: '*', Action: 'kms:CreateGrant',
          Condition: {
            StringEquals: { 'aws:PrincipalArn': `arn:aws:iam::${AGENT_AWS_ACCOUNT_ID}:role/stokd-agent-validation-deploy` },
            Bool: { 'kms:GrantIsForAWSResource': true },
          },
        },
        {
          Sid: 'ExactAgentWorkloads', Effect: 'Allow', Principal: '*', Resource: '*',
          Action: ['kms:Decrypt', 'kms:DescribeKey', 'kms:Encrypt', 'kms:GenerateDataKey', 'kms:ReEncrypt*'],
          Condition: { StringLike: { 'aws:PrincipalArn': [
            `arn:aws:iam::${AGENT_AWS_ACCOUNT_ID}:role/${mongoRoleName}`,
            `arn:aws:iam::${AGENT_AWS_ACCOUNT_ID}:role/stokd-agent-workload-mongo-restore-val12`,
            `arn:aws:iam::${AGENT_AWS_ACCOUNT_ID}:role/stokd-agent-workload-api-${identity.stage}-*`,
          ] } },
        },
      ],
    })
    const kmsKey = new aws.kms.Key('AgentDataKey', {
      description: `Retained Agent ${identity.stage} data custody`,
      enableKeyRotation: true,
      deletionWindowInDays: 30,
      policy: keyPolicy,
      tags,
    }, { protect: true, retainOnDelete: true, dependsOn: [mongoRole] })
    const kmsAlias = new aws.kms.Alias('AgentDataKeyAlias', { name: `alias/stokd-agent-${identity.stage}`, targetKeyId: kmsKey.keyId }, { protect: true, retainOnDelete: true })

    function retainedBucket(kind: 'artifacts' | 'backups') {
      const bucketName = kind === 'artifacts' ? artifactBucketName(identity.stage) : backupBucketName(identity.stage)
      const bucket = new aws.s3.Bucket(`Agent${kind}Bucket`, {
        bucket: bucketName,
        forceDestroy: false,
        tags,
      }, { protect: true, retainOnDelete: true })
      const block = new aws.s3.BucketPublicAccessBlock(`Agent${kind}PublicAccess`, {
        bucket: bucket.id, blockPublicAcls: true, blockPublicPolicy: true, ignorePublicAcls: true, restrictPublicBuckets: true,
      }, { protect: true, retainOnDelete: true })
      new aws.s3.BucketOwnershipControls(`Agent${kind}Ownership`, { bucket: bucket.id, rule: { objectOwnership: 'BucketOwnerEnforced' } }, { protect: true, retainOnDelete: true })
      new aws.s3.BucketVersioningV2(`Agent${kind}Versioning`, { bucket: bucket.id, versioningConfiguration: { status: 'Enabled' } }, { protect: true, retainOnDelete: true })
      new aws.s3.BucketServerSideEncryptionConfigurationV2(`Agent${kind}Encryption`, {
        bucket: bucket.id,
        rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: 'aws:kms', kmsMasterKeyId: kmsKey.arn }, bucketKeyEnabled: true }],
      }, { protect: true, retainOnDelete: true })
      new aws.s3.BucketLifecycleConfigurationV2(`Agent${kind}Lifecycle`, {
        bucket: bucket.id,
        rules: [{
          id: 'thirty-day-version-custody', status: 'Enabled', filter: {},
          ...(kind === 'backups' ? { expiration: { days: 30 } } : {}),
          noncurrentVersionExpiration: { noncurrentDays: 30 },
          abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
        }],
      }, { protect: true, retainOnDelete: true })
      new aws.s3.BucketPolicy(`Agent${kind}Policy`, {
        bucket: bucket.id,
        policy: $jsonStringify({ Version: '2012-10-17', Statement: [
          { Sid: 'DenyNonTls', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [bucket.arn, $interpolate`${bucket.arn}/*`], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
          { Sid: 'DenyUnencryptedWrites', Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: $interpolate`${bucket.arn}/*`, Condition: { StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } } },
          { Sid: 'DenyWrongKey', Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: $interpolate`${bucket.arn}/*`, Condition: { StringNotEquals: { 's3:x-amz-server-side-encryption-aws-kms-key-id': kmsKey.arn } } },
        ] }),
      }, { protect: true, retainOnDelete: true, dependsOn: [block] })
      return bucket
    }
    const artifactBucket = retainedBucket('artifacts')
    const backupBucket = retainedBucket('backups')

    const secretStack = new aws.cloudformation.Stack('AgentGeneratedCredentials', {
      name: `stokd-agent-${identity.stage}-credentials`,
      capabilities: ['CAPABILITY_NAMED_IAM'],
      templateBody: $jsonStringify({
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: Object.fromEntries((['runtime', 'migration', 'backup'] as const).map(kind => [`${kind[0].toUpperCase()}${kind.slice(1)}Secret`, {
          Type: 'AWS::SecretsManager::Secret', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
          Properties: {
            Name: `stokd-agent-${identity.stage}-${kind}`, KmsKeyId: kmsKey.arn,
            GenerateSecretString: { PasswordLength: 48, ExcludePunctuation: true },
            Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          },
        }])),
        Outputs: {
          RuntimeSecretArn: { Value: { Ref: 'RuntimeSecret' } },
          MigrationSecretArn: { Value: { Ref: 'MigrationSecret' } },
          BackupSecretArn: { Value: { Ref: 'BackupSecret' } },
        },
      }),
      tags,
    }, { protect: true, retainOnDelete: true })
    const runtimeSecretArn = secretStack.outputs.apply(outputs => outputs.RuntimeSecretArn)
    const migrationSecretArn = secretStack.outputs.apply(outputs => outputs.MigrationSecretArn)
    const backupSecretArn = secretStack.outputs.apply(outputs => outputs.BackupSecretArn)
    const sourceSecrets = identity.stage === 'restore-val12' ? {
      runtime: aws.secretsmanager.getSecretOutput({ name: 'stokd-agent-source-val12-runtime' }),
      migration: aws.secretsmanager.getSecretOutput({ name: 'stokd-agent-source-val12-migration' }),
      backup: aws.secretsmanager.getSecretOutput({ name: 'stokd-agent-source-val12-backup' }),
    } : undefined

    const clusterName = `stokd-agent-api-${identity.stage}`
    const apiServiceName = `stokd-agent-api-${identity.stage}`
    const cluster = new sst.aws.Cluster('AgentApiCluster', {
      vpc: {
        id: vpc.id,
        securityGroups: [apiSecurityGroup.id],
        containerSubnets: vpc.privateSubnets,
        loadBalancerSubnets: vpc.publicSubnets,
        cloudmapNamespaceId: vpc.nodes.cloudmapNamespace.id,
        cloudmapNamespaceName: vpc.nodes.cloudmapNamespace.name,
      },
      transform: { cluster: { name: clusterName, tags: runtimeTags } },
    })
    const apiClusterArn = `arn:aws:ecs:${AGENT_AWS_REGION}:${AGENT_AWS_ACCOUNT_ID}:cluster/${clusterName}`
    const apiServiceArn = `arn:aws:ecs:${AGENT_AWS_REGION}:${AGENT_AWS_ACCOUNT_ID}:service/${clusterName}/${apiServiceName}`

    const sourceSecretArns = sourceSecrets ? [sourceSecrets.runtime.arn, sourceSecrets.migration.arn, sourceSecrets.backup.arn] : []
    const usableKmsKeys = sourceSecrets ? [kmsKey.arn, sourceSecrets.runtime.kmsKeyId] : [kmsKey.arn]
    const mongoPolicy = new aws.iam.RolePolicy('AgentMongoPolicy', {
      role: mongoRole.id,
      policy: $jsonStringify({ Version: '2012-10-17', Statement: [
        { Sid: 'EcrAuth', Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
        { Sid: 'ExactRuntimeImages', Effect: 'Allow', Action: ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'], Resource: `arn:aws:ecr:${AGENT_AWS_REGION}:${AGENT_AWS_ACCOUNT_ID}:repository/stokd-agent-runtime` },
        { Sid: 'ExactTargetSecrets', Effect: 'Allow', Action: ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue', 'secretsmanager:ListSecretVersionIds', ...(identity.stage === 'restore-val12' ? ['secretsmanager:PutSecretValue'] : [])], Resource: [runtimeSecretArn, migrationSecretArn, backupSecretArn] },
        ...(identity.stage === 'restore-val12' ? [{ Sid: 'SourceSecretsReadOnly', Effect: 'Allow', Action: ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue', 'secretsmanager:ListSecretVersionIds'], Resource: sourceSecretArns }] : []),
        { Sid: 'ExactKeyUse', Effect: 'Allow', Action: ['kms:Decrypt', 'kms:DescribeKey', 'kms:Encrypt', 'kms:GenerateDataKey'], Resource: usableKmsKeys },
        { Sid: 'VersionedCustody', Effect: 'Allow', Action: ['s3:GetBucketLocation', 's3:GetBucketVersioning', 's3:ListBucket', 's3:ListBucketVersions'], Resource: [artifactBucket.arn, backupBucket.arn, ...(identity.stage === 'restore-val12' ? [`arn:aws:s3:::${artifactBucketName('source-val12')}`, `arn:aws:s3:::${backupBucketName('source-val12')}`] : [])] },
        { Sid: 'TargetVersionedObjects', Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject', 's3:PutObjectTagging', 's3:AbortMultipartUpload'], Resource: [$interpolate`${artifactBucket.arn}/*`, $interpolate`${backupBucket.arn}/*`] },
        ...(identity.stage === 'restore-val12' ? [{ Sid: 'SourceObjectsReadOnly', Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: [`arn:aws:s3:::${artifactBucketName('source-val12')}/*`, `arn:aws:s3:::${backupBucketName('source-val12')}/*`] }] : []),
        { Sid: 'InstanceCustodyReadback', Effect: 'Allow', Action: ['ec2:DescribeInstances', 'ec2:DescribeVolumes'], Resource: '*' },
        { Sid: 'SsmManagedInstance', Effect: 'Allow', Action: ['ssm:UpdateInstanceInformation', 'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel', 'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel', 'ec2messages:AcknowledgeMessage', 'ec2messages:DeleteMessage', 'ec2messages:FailMessage', 'ec2messages:GetEndpoint', 'ec2messages:GetMessages', 'ec2messages:SendReply'], Resource: '*' },
        { Sid: 'ExactApiAdmission', Effect: 'Allow', Action: ['ecs:DescribeServices', 'ecs:UpdateService'], Resource: apiServiceArn },
        { Sid: 'NoRedispatch', Effect: 'Deny', Action: ['ecs:RunTask', 'events:PutEvents', 'lambda:InvokeFunction', 'sns:Publish', 'sqs:SendMessage', 'states:StartExecution'], Resource: '*' },
        { Sid: 'NoPersistentDeletion', Effect: 'Deny', Action: ['ec2:DeleteVolume', 'kms:ScheduleKeyDeletion', 's3:DeleteBucket', 's3:DeleteObject', 's3:DeleteObjectVersion', 'secretsmanager:DeleteSecret'], Resource: '*' },
      ] }),
    })
    const instanceProfile = new aws.iam.InstanceProfile('AgentMongoInstanceProfile', { name: `stokd-agent-workload-mongo-${identity.stage}`, role: mongoRole.name })

    const firstPrivateSubnet = vpc.nodes.privateSubnets.apply(subnets => subnets[0]!)
    const mongoEni = new aws.ec2.NetworkInterface('AgentMongoEni', {
      subnetId: firstPrivateSubnet.id,
      securityGroups: [mongoSecurityGroup.id],
      sourceDestCheck: true,
      tags: runtimeTags,
    })
    const dataVolume = new aws.ebs.Volume('AgentMongoDataVolume', {
      availabilityZone: firstPrivateSubnet.availabilityZone,
      encrypted: true,
      kmsKeyId: kmsKey.arn,
      size: 30,
      type: 'gp3',
      iops: 3000,
      throughput: 125,
      tags: { ...tags, InitializationState: 'pending-v1' },
    }, { protect: true, retainOnDelete: true, ignoreChanges: ['tags'] })
    const volumeInitializationPolicy = new aws.iam.RolePolicy('AgentMongoVolumeInitializationPolicy', {
      role: mongoRole.id,
      policy: $jsonStringify({ Version: '2012-10-17', Statement: [{
        Sid: 'FinalizeExactFreshVolumeOnce', Effect: 'Allow', Action: 'ec2:CreateTags', Resource: dataVolume.arn,
        Condition: {
          StringEquals: {
            'ec2:ResourceTag/Project': 'stokd-agent',
            'ec2:ResourceTag/Stage': identity.stage,
            'ec2:ResourceTag/InitializationState': 'pending-v1',
            'aws:RequestTag/InitializationState': 'initialized-v1',
          },
          'ForAllValues:StringEquals': { 'aws:TagKeys': ['InitializationState'] },
        },
      }] }),
    })

    const mongoDiscoveryService = new aws.servicediscovery.Service('AgentMongoDiscoveryService', {
      name: `mongo-${identity.stage}`,
      dnsConfig: {
        namespaceId: vpc.nodes.cloudmapNamespace.id,
        dnsRecords: [{ ttl: 30, type: 'A' }],
        routingPolicy: 'MULTIVALUE',
      },
      healthCheckCustomConfig: { failureThreshold: 1 },
      tags: runtimeTags,
    })
    const mongoDiscoveryRegistration = new aws.servicediscovery.Instance('AgentMongoDiscoveryRegistration', {
      instanceId: `mongo-${identity.stage}`,
      serviceId: mongoDiscoveryService.id,
      attributes: { AWS_INSTANCE_IPV4: mongoEni.privateIp },
    })

    const hostFiles = {
      'host-common': runtime('host-common.sh'),
      'mongo-service': runtime('host-mongo-service.sh'),
      'migrate-host': runtime('host-migrate.sh'),
      'validation-seed-host': runtime('host-validation-seed.sh'),
      'backup-host': runtime('host-backup.sh'),
      'restore-host': runtime('host-restore.sh'),
      'host-bootstrap': runtime('host-bootstrap.sh'),
      'stokd-agent-mongo.service': runtime('systemd/stokd-agent-mongo.service'),
      'stokd-agent-backup.service': runtime('systemd/stokd-agent-backup.service'),
      'stokd-agent-backup.timer': runtime('systemd/stokd-agent-backup.timer'),
    }
    const encodedFiles = Object.fromEntries(Object.entries(hostFiles).map(([name, contents]) => [name, Buffer.from(contents).toString('base64')]))
    const hostEnvironment = $interpolate`AGENT_AWS_ACCOUNT_ID=${AGENT_AWS_ACCOUNT_ID}
AWS_REGION=${AGENT_AWS_REGION}
AGENT_STAGE=${identity.stage}
AGENT_DATABASE_NAME=${identity.databaseName}
AGENT_MONGO_HOST=mongo-${identity.stage}.sst:27017
AGENT_MONGO_IMAGE=${mongoImage}
AGENT_MAINTENANCE_IMAGE=${maintenanceImage}
AGENT_VOLUME_ID=${dataVolume.id}
AGENT_KMS_KEY_ARN=${kmsKey.arn}
AGENT_ARTIFACT_BUCKET=${artifactBucket.bucket}
AGENT_BACKUP_BUCKET=${backupBucket.bucket}
AGENT_RUNTIME_SECRET_ARN=${runtimeSecretArn}
AGENT_MIGRATION_SECRET_ARN=${migrationSecretArn}
AGENT_BACKUP_SECRET_ARN=${backupSecretArn}
AGENT_SOURCE_BACKUP_BUCKET=${backupBucketName('source-val12')}
AGENT_SOURCE_RUNTIME_SECRET_ARN=${sourceSecrets?.runtime.arn ?? runtimeSecretArn}
AGENT_SOURCE_MIGRATION_SECRET_ARN=${sourceSecrets?.migration.arn ?? migrationSecretArn}
AGENT_SOURCE_BACKUP_SECRET_ARN=${sourceSecrets?.backup.arn ?? backupSecretArn}
AGENT_API_CLUSTER_ARN=${apiClusterArn}
AGENT_API_SERVICE_ARN=${apiServiceArn}`
    const userData = $interpolate`#!/bin/bash
set -euo pipefail
install -d -m 0700 /etc/stokd-agent /opt/stokd-agent/bin
printf '%s' '${Buffer.from('HOST_ENV_PLACEHOLDER').toString('base64')}' >/dev/null
${Object.entries(encodedFiles).map(([name, encoded]) => {
  const target = name.endsWith('.service') || name.endsWith('.timer') ? `/etc/systemd/system/${name}` : `/opt/stokd-agent/bin/${name}`
  return `printf '%s' '${encoded}' | base64 -d > '${target}'\nchmod ${target.startsWith('/opt/') ? '0555' : '0444'} '${target}'`
}).join('\n')}
cat > /etc/stokd-agent/host.env <<'AGENT_ENV'
${hostEnvironment}
AGENT_ENV
chmod 0400 /etc/stokd-agent/host.env
/opt/stokd-agent/bin/host-bootstrap
`
    const instance = new aws.ec2.Instance('AgentMongoInstance', {
      ami: 'ami-0fe74bfcad4fd6bd2',
      instanceType: 't3.small',
      iamInstanceProfile: instanceProfile.name,
      networkInterfaces: [{ networkInterfaceId: mongoEni.id, deviceIndex: 0 }],
      metadataOptions: { httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1, instanceMetadataTags: 'disabled' },
      rootBlockDevice: { encrypted: true, kmsKeyId: kmsKey.arn, volumeType: 'gp3', volumeSize: 16, deleteOnTermination: true, tags: runtimeTags },
      volumeTags: runtimeTags,
      userData: userData,
      userDataReplaceOnChange: true,
      tags: runtimeTags,
    }, { dependsOn: [mongoPolicy, volumeInitializationPolicy, mongoDiscoveryRegistration, s3Endpoint, ...endpoints] })
    const attachment = new aws.ec2.VolumeAttachment('AgentMongoVolumeAttachment', {
      deviceName: '/dev/sdf',
      instanceId: instance.id,
      volumeId: dataVolume.id,
      stopInstanceBeforeDetaching: true,
    })

    const manifest = {
      schemaVersion: '1.0', manifestVersion: AGENT_INFRA_MANIFEST_VERSION,
      accountId: AGENT_AWS_ACCOUNT_ID, region: AGENT_AWS_REGION, stage: identity.stage,
      sourceDigest, recoveryMode: identity.recoveryMode,
      cluster: { id: cluster.id, arn: apiClusterArn, serviceName: apiServiceName, serviceArn: apiServiceArn },
      vpc: {
        id: vpc.id, containerSubnets: vpc.privateSubnets, loadBalancerSubnets: vpc.publicSubnets,
        loadBalancerCidrs: vpc.nodes.publicSubnets.apply(values => values.map(value => value.cidrBlock)),
        apiSecurityGroupId: apiSecurityGroup.id, mongoSecurityGroupId: mongoSecurityGroup.id,
        cloudmapNamespaceId: vpc.nodes.cloudmapNamespace.id, cloudmapNamespaceName: vpc.nodes.cloudmapNamespace.name,
        natGatewayIds: vpc.nodes.natGateways.apply(values => values.map(value => value.id)),
        elasticIpIds: vpc.nodes.elasticIps.apply(values => values.map(value => value.id)),
      },
      mongo: {
        host: `mongo-${identity.stage}.sst:27017`, databaseName: identity.databaseName, replicaSet: 'agent-rs',
        instanceId: instance.id, networkInterfaceId: mongoEni.id, volumeId: dataVolume.id,
        discoveryServiceId: mongoDiscoveryService.id, discoveryInstanceId: mongoDiscoveryRegistration.instanceId,
      },
      custody: { kmsKeyArn: kmsKey.arn, kmsAliasName: kmsAlias.name, artifactBucket: artifactBucket.bucket, backupBucket: backupBucket.bucket },
      secrets: { runtimeArn: runtimeSecretArn, migrationArn: migrationSecretArn, backupArn: backupSecretArn },
      images: { mongodb: mongoImage, maintenance: maintenanceImage },
      hostedZoneId: 'Z0974146XEXJDMNXU573',
    }
    const manifestParameter = new aws.ssm.Parameter('AgentInfrastructureManifest', {
      name: infrastructureManifestParameter(identity.stage),
      type: 'String', dataType: 'text', tier: 'Standard',
      value: $jsonStringify(manifest),
      tags,
    }, { protect: true, retainOnDelete: true, dependsOn: [attachment] })
    return { manifestParameter: manifestParameter.name, clusterId: cluster.id, mongoInstanceId: instance.id, databaseVolumeId: dataVolume.id }
  },
})

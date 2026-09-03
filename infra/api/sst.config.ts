/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    if (!['source-val12', 'restore-val12'].includes(input.stage)) throw new Error(`unsupported Agent validation stage: ${input.stage}`)
    return {
      name: 'stokd-agent-api', home: 'aws', version: '3.19.3', removal: 'remove', protect: false,
      providers: { aws: { region: 'us-east-1', defaultTags: { tags: { Project: 'stokd-agent', Stage: input.stage, ManagedBy: 'sst-3.19.3' } } } },
    }
  },
  async run() {
    const { assertSstDeploymentIdentity } = await import('../shared/deployment-guard')
    const { AGENT_AWS_ACCOUNT_ID, AGENT_AWS_REGION, AGENT_HOSTED_ZONE_ID, infrastructureManifestParameter, resolveAgentStage } = await import('../shared/constants')
    const { agentTags, ecsTaskTrustPolicy, executionPolicy, workloadBoundaryArn } = await import('../shared/policy')
    const identity = resolveAgentStage($app.stage)
    await assertSstDeploymentIdentity(identity.stage)
    const tags = agentTags(identity.stage, 'stateless')
    const apiImage = process.env.AGENT_API_IMAGE
    const sourceDigest = process.env.AGENT_SOURCE_DIGEST
    if (!apiImage || !/^167217327520\.dkr\.ecr\.us-east-1\.amazonaws\.com\/stokd-agent-runtime@sha256:[a-f0-9]{64}$/.test(apiImage)) throw new Error('AGENT_API_IMAGE must be an exact private ECR digest')
    if (!sourceDigest || !/^[a-f0-9]{40}$/.test(sourceDigest)) throw new Error('AGENT_SOURCE_DIGEST must be the exact source commit')

    const manifestParameter = aws.ssm.getParameterOutput({ name: infrastructureManifestParameter(identity.stage), withDecryption: false })
    const manifest = manifestParameter.value.apply(raw => {
      const value = JSON.parse(raw)
      if (value?.schemaVersion !== '1.0' || value?.manifestVersion !== 1 || value?.accountId !== AGENT_AWS_ACCOUNT_ID || value?.region !== AGENT_AWS_REGION || value?.stage !== identity.stage || value?.sourceDigest !== sourceDigest) throw new Error('data manifest identity or source digest is invalid')
      if (value?.recoveryMode !== identity.recoveryMode || value?.mongo?.host !== `mongo-${identity.stage}.sst:27017` || value?.mongo?.databaseName !== identity.databaseName || value?.mongo?.replicaSet !== 'agent-rs') throw new Error('data manifest Mongo/recovery identity is invalid')
      if (!Array.isArray(value?.vpc?.containerSubnets) || value.vpc.containerSubnets.length !== 2 || !Array.isArray(value?.vpc?.loadBalancerSubnets) || value.vpc.loadBalancerSubnets.length !== 2) throw new Error('data manifest subnet inventory is invalid')
      if (!Array.isArray(value?.vpc?.natGatewayIds) || value.vpc.natGatewayIds.length !== 0 || !Array.isArray(value?.vpc?.elasticIpIds) || value.vpc.elasticIpIds.length !== 0) throw new Error('endpoint-only data manifest unexpectedly contains NAT or EIP resources')
      if (value?.cluster?.serviceName !== `stokd-agent-api-${identity.stage}` || value?.cluster?.serviceArn !== `arn:aws:ecs:${AGENT_AWS_REGION}:${AGENT_AWS_ACCOUNT_ID}:service/stokd-agent-api-${identity.stage}/stokd-agent-api-${identity.stage}`) throw new Error('data manifest ECS identity is invalid')
      if (!/^arn:aws:secretsmanager:us-east-1:167217327520:secret:stokd-agent-(source|restore)-val12-runtime-[A-Za-z0-9]{6}$/.test(value?.secrets?.runtimeArn ?? '')) throw new Error('data manifest runtime secret ARN is invalid')
      return value
    })
    const certificate = aws.ssm.getParameterOutput({ name: '/stokd-agent/shared/validation-certificate/v1', withDecryption: false }).value.apply(value => {
      if (!/^arn:aws:acm:us-east-1:167217327520:certificate\/[a-f0-9-]{36}$/.test(value)) throw new Error('retained exact-SAN certificate parameter is invalid')
      return value
    })
    const cluster = sst.aws.Cluster.get('AgentApiClusterReference', {
      id: manifest.cluster.id,
      vpc: {
        id: manifest.vpc.id,
        securityGroups: [manifest.vpc.apiSecurityGroupId],
        containerSubnets: manifest.vpc.containerSubnets,
        loadBalancerSubnets: manifest.vpc.loadBalancerSubnets,
        cloudmapNamespaceId: manifest.vpc.cloudmapNamespaceId,
        cloudmapNamespaceName: manifest.vpc.cloudmapNamespaceName,
      },
    })

    const albSecurityGroup = new aws.ec2.SecurityGroup('AgentAlbSecurityGroup', {
      name: `stokd-agent-alb-exact-${identity.stage}`,
      description: 'Exact public TLS load balancer; egress only to the Agent API task group',
      vpcId: manifest.vpc.id,
      ingress: [
        { protocol: 'tcp', fromPort: 80, toPort: 80, cidrBlocks: ['0.0.0.0/0'], description: 'HTTP redirect' },
        { protocol: 'tcp', fromPort: 443, toPort: 443, cidrBlocks: ['0.0.0.0/0'], description: 'HTTPS' },
      ],
      egress: [],
      tags,
    })
    const albToApiEgress = new aws.ec2.SecurityGroupRule('AgentAlbToApiEgress', {
      type: 'egress', protocol: 'tcp', fromPort: 8080, toPort: 8080,
      securityGroupId: albSecurityGroup.id,
      sourceSecurityGroupId: manifest.vpc.apiSecurityGroupId,
      description: 'Exact ALB to Agent API task group',
    })
    const apiIngress = new aws.ec2.SecurityGroupRule('AgentApiIngressFromExactAlb', {
      type: 'ingress', protocol: 'tcp', fromPort: 8080, toPort: 8080,
      securityGroupId: manifest.vpc.apiSecurityGroupId,
      sourceSecurityGroupId: albSecurityGroup.id,
      description: 'Only the exact Agent ALB security group may reach API tasks',
    })

    const repositoryArn = `arn:aws:ecr:${AGENT_AWS_REGION}:${AGENT_AWS_ACCOUNT_ID}:repository/stokd-agent-runtime`
    const logGroupName = `/stokd-agent/${identity.stage}/api`
    const logGroupArn = `arn:aws:logs:${AGENT_AWS_REGION}:${AGENT_AWS_ACCOUNT_ID}:log-group:${logGroupName}`
    const executionRole = new aws.iam.Role('AgentApiExecutionRole', {
      name: `stokd-agent-workload-api-${identity.stage}-execution`, assumeRolePolicy: ecsTaskTrustPolicy(), permissionsBoundary: workloadBoundaryArn, tags,
    })
    new aws.iam.RolePolicy('AgentApiExecutionPolicy', {
      role: executionRole.id,
      policy: $jsonStringify({ Version: '2012-10-17', Statement: [
        ...JSON.parse(executionPolicy(repositoryArn, logGroupArn)).Statement,
        { Sid: 'OnlyRuntimeSecret', Effect: 'Allow', Action: ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'], Resource: manifest.secrets.runtimeArn },
        { Sid: 'DecryptOnlyStageKey', Effect: 'Allow', Action: ['kms:Decrypt', 'kms:DescribeKey'], Resource: manifest.custody.kmsKeyArn },
      ] }),
    })
    const taskRole = new aws.iam.Role('AgentApiTaskRole', {
      name: `stokd-agent-workload-api-${identity.stage}-task`, assumeRolePolicy: ecsTaskTrustPolicy(), permissionsBoundary: workloadBoundaryArn, tags,
    })
    new aws.iam.RolePolicy('AgentApiTaskPolicy', {
      role: taskRole.id,
      policy: JSON.stringify({ Version: '2012-10-17', Statement: [
        { Sid: 'NoAwsControlPlaneAccess', Effect: 'Deny', Action: ['ecs:*', 'events:*', 'lambda:InvokeFunction', 'secretsmanager:*', 'sns:Publish', 'sqs:SendMessage', 'ssm:*', 'states:StartExecution'], Resource: '*' },
      ] }),
    })

    const service = new sst.aws.Service('AgentApiService', {
      cluster,
      image: apiImage,
      cpu: '0.5 vCPU', memory: '1 GB', architecture: 'x86_64',
      taskRole: taskRole.name,
      executionRole: executionRole.name,
      scaling: { min: 1, max: 1, cpuUtilization: false, memoryUtilization: false },
      environment: {
        AGENT_STAGE: identity.stage,
        AGENT_DATABASE_NAME: identity.databaseName,
        AGENT_MONGO_HOST: manifest.mongo.host,
        AGENT_REPLICA_SET: 'agent-rs',
        AGENT_RECOVERY_MODE: identity.recoveryMode,
        NODE_ENV: 'production', PORT: '8080',
      },
      ssm: { AGENT_RUNTIME_SECRET_VALUE: manifest.secrets.runtimeArn },
      health: {
        command: ['CMD-SHELL', "node -e \"fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
        startPeriod: '90 seconds', interval: '30 seconds', timeout: '20 seconds', retries: 3,
      },
      logging: { name: logGroupName, retention: '1 month' },
      wait: true,
      loadBalancer: {
        public: true,
        domain: { name: identity.domain, cert: certificate, dns: sst.aws.dns({ zone: AGENT_HOSTED_ZONE_ID }) },
        rules: [
          { listen: '80/http', redirect: '443/https' },
          { listen: '443/https', forward: '8080/http' },
        ],
        health: { '8080/http': { path: '/health', interval: '30 seconds', timeout: '20 seconds', healthyThreshold: 2, unhealthyThreshold: 3, successCodes: '200' } },
      },
      transform: {
        service: args => {
          args.name = `stokd-agent-api-${identity.stage}`
          args.enableExecuteCommand = false
          args.propagateTags = 'SERVICE'
          args.tags = tags
        },
        taskDefinition: args => {
          args.family = `stokd-agent-api-${identity.stage}`
          args.tags = tags
          args.runtimePlatform = { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' }
        },
        logGroup: args => { args.tags = tags },
        loadBalancer: args => {
          args.name = `agent-${identity.stage}`
          args.idleTimeout = 3600
          args.enableDeletionProtection = false
          args.securityGroups = [albSecurityGroup.id]
          args.tags = tags
        },
        loadBalancerSecurityGroup: args => {
          args.name = `stokd-agent-alb-component-unused-${identity.stage}`
          args.description = 'Unused SST component group; the load balancer is bound to AgentAlbSecurityGroup'
          args.ingress = []
          args.egress = []
          args.tags = tags
        },
        target: args => { args.deregistrationDelay = 30; args.tags = tags },
      },
    }, { dependsOn: [albToApiEgress, apiIngress] })
    return { url: service.url, serviceArn: manifest.cluster.serviceArn, taskDefinitionArn: service.nodes.taskDefinition.arn, sourceDigest }
  },
})

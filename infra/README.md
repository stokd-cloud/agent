
# Standalone Agent infrastructure

The Agent service owns two independent SST 3.19.3 applications:

- `data` owns the endpoint-only VPC, MongoDB replica set, encrypted artifact and backup buckets, KMS keys, database credentials, backup task, and restore task. Persistent resources are retained and protected.
- `api` consumes the versioned, non-secret data manifest from Parameter Store and deploys only the replaceable Fargate API, public HTTPS load balancer, and DNS.

The supported validation stages are `source-val12` and `restore-val12`. They resolve to `agent-source-val12.stokd.cloud` and `agent-restore-val12.stokd.cloud`. The restore stage is always observation-only.

All routine actions run through `node scripts/infra-action.mjs`. The wrapper and both SST configs independently require AWS account `167217327520`, region `us-east-1`, and the bounded `stokd-agent-validation-deploy` role. They refuse the account root principal. Infrastructure commands also refuse to run until the administrator-only bootstrap in `infra/bootstrap` has been reviewed and applied. Bootstrap uses GitHub OIDC and never creates access keys.

The bootstrap adopts the account's existing SST v5 home as a read-bound external dependency; it never creates, migrates, tags, or reconfigures the shared SST buckets, ECR repository, or `/sst/bootstrap` record. Before exposing the deploy role on a clean validation stage, the administrator initializes four empty SST checkpoints under one global create-only guard. The durable receipts bind the reviewed SST 3.19.3/Pulumi 3.210.0 runtime, the exact bootstrap version and state bucket, the retained state versions, and the six stage/fallback passphrase and empty-secret identities without recording decrypted values. The recovery token is generated and stored by the operator before the guard can be created. A failed initializer keeps its cloud-visible guard; retry requires that same token. Routine actions refuse an active initializer and perform read-only passphrase/empty-secret preflight before any SST command.

The existing SST state and asset buckets, asset ECR repository, AWS-managed SSM key, six passphrase parameters, encrypted empty-secret objects, and initialization receipts remain external retained runtime state in the Terraform handoff. They are not Terraform import targets.

No SST app imports Stokd or Mono source. The only data-to-API coupling is the non-secret `/stokd-agent/<stage>/infrastructure-manifest/v1` parameter.

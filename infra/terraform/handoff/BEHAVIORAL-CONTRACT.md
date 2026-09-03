# Work 1.2 — Terraform behavioral-contract handoff

Required by AC-1.2.b. This states what the infrastructure must *do*, independent
of which tool declares it, so the Terraform topology can be verified against the
same contract the SST scaffold was written to satisfy.

Companion artifact: [`import-inventory.json`](import-inventory.json) — the
physical-resource and import mapping.

## 1. Retained-custody semantics

Resources are split into two classes, and the split is enforced, not documented.

**Persistent** — holds customer state, survives a stage teardown. Every one
carries `lifecycle { prevent_destroy = true }`:

| Resource | Retention behavior |
|---|---|
| KMS key + alias | 30-day deletion window, rotation enabled. Scheduling deletion is denied to workload roles. |
| Artifacts bucket | Versioned, SSE-KMS, `BucketOwnerEnforced`. Current versions kept indefinitely; noncurrent 30 days. |
| Backups bucket | Same, plus current-version expiry at 30 days — the daily/30-day backup window. |
| MongoDB data volume | Encrypted with the stage key. Separate from the instance, so replacing the host never replaces the data. |
| Three service secrets | 30-day recovery window, mirroring the scaffold's `DeletionPolicy: Retain`. |
| Infrastructure manifest | The readback surface describing what is actually deployed. |

A `terraform destroy` that would remove any of these **fails at plan time**.
That is the mechanical form of VAL-OPS-001's "resource teardown refuses
unacknowledged persistent-data deletion": removing custody requires deleting the
`prevent_destroy` block first, which is an explicit, reviewable diff rather than
a flag on a command line.

Workload roles additionally carry a standing `Deny` on `ec2:DeleteVolume`,
`kms:ScheduleKeyDeletion`, `s3:DeleteBucket`, `s3:DeleteObject`,
`s3:DeleteObjectVersion` and `secretsmanager:DeleteSecret`. Neither the running
service nor the MongoDB host can destroy custody even if compromised.

**Rebuildable** — network, compute, load balancing, log groups, IAM roles. These
may be destroyed and recreated without data loss.

## 2. Effective IAM: no model-invoke authority

This is the assertion the whole item exists to make provable. Cloud stores and
coordinates state; **every** provider invocation, Bedrock included, runs on an
enrolled user machine with that machine's own credentials.

It holds through three independent mechanisms:

1. **The permissions boundary is an allowlist.** `stokd-agent-workload-boundary`
   enumerates the permitted actions — ECR pulls, S3 object custody, KMS use,
   Secrets Manager reads, the two exact ECS admission calls, observability. No
   Bedrock or other model-invoke action appears in it. A boundary caps effective
   permissions to the intersection, so **no policy attached to a bounded role can
   grant one**. Every workload role here carries it.
2. **Explicit denies.** `aws_iam_role.mongo`, `aws_iam_role.api_execution` and
   `aws_iam_role.api_task` each deny `bedrock:InvokeModel`,
   `bedrock:InvokeModelWithResponseStream`, `bedrock:Converse` and
   `bedrock:ConverseStream`. This is redundant with the boundary by design: it
   makes `iam simulate-principal-policy` report `explicitDeny` rather than
   `implicitDeny`, so the readback evidence is unambiguous.
3. **No provider credential reaches a task.** The API task definition injects
   exactly one secret, the stage runtime credential. The execution role may read
   that one ARN — not a wildcard over the stage's secrets. The task role denies
   `secretsmanager:*` outright.

**Required readback** (control plane, not manifests):

- `iam simulate-principal-policy` for both API roles and the MongoDB role against
  `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` → denied.
- `iam get-role` on all three → `PermissionsBoundary` is the workload boundary.
- `ecs describe-task-definition` → no provider secret or model configuration in
  `secrets` or `environment`.

## 3. Ordered lifecycle

Order matters; several steps are only safe because an earlier one completed.

1. **Bootstrap** (once per account, `infra/bootstrap/template.yaml`): boundary,
   deploy role, ECR repository, OIDC trust, retained certificate.
2. **Encrypted Terraform state backend** must exist before the first apply. See
   §5.
3. **Apply `source-val12`.** Network and endpoints come up before the MongoDB
   host, because the host has no route to the internet and reaches ECR, KMS,
   Secrets Manager and SSM exclusively through interface endpoints. The host's
   `depends_on` makes this explicit rather than incidental.
4. **First boot formats the data volume exactly once.** The volume is tagged
   `InitializationState=pending-v1` at creation. The host flips it to
   `initialized-v1` after a successful format, using a policy that permits *only*
   that single tag transition, conditioned on the current value being
   `pending-v1`. A re-run therefore cannot reformat a volume that already holds
   data. Terraform ignores tag drift on the volume so it never fights the host.
5. **Migrate.** Versioned and additive. Explicit readiness and version checks;
   repeated application is safe; an interrupted migration leaves earlier state
   readable and the schema version unadvanced; an incompatible client fails
   before serving writes rather than writing partially.
6. **Deploy the API service** and confirm state persists across a task restart.
7. **Back up** on the daily timer to the versioned backups bucket.

## 4. Restore

`restore-val12` exists to prove a restore is a *reconstruction*, never a replay.

- It comes up in `recovery_mode = restored_observation`, carried into the task
  environment as `AGENT_RECOVERY_MODE`.
- It reads the source stage's retained backups and secrets **read-only**. That
  direction is one-way: the source stage's policies grant the restore stage's
  Mongo role nothing, and the source stage never reads the restore stage.
- Restored execution records are observation-only until reconciled. The Mongo
  role denies `ecs:RunTask`, `events:PutEvents`, `lambda:InvokeFunction`,
  `sns:Publish`, `sqs:SendMessage` and `states:StartExecution`, so a restored
  pending record **cannot** redispatch work. This is the zero-redispatch proof.
- A missing object version is recorded as an explicit degraded record. It is
  never materialized as a ready object.
- Every restore records resource IDs, restore point, object manifest and custody.
- Production restore and destructive teardown are never used as a test.

## 5. Difference from the SST scaffold — needs a decision

The scaffold generated the three service credentials through a nested
CloudFormation stack purely to borrow `GenerateSecretString`, so the plaintext
never entered SST state. **The Terraform AWS provider has no equivalent
generator.** `random_password` is used instead, and the generated value lands in
Terraform state.

Consequences, stated plainly:

- Encrypted remote state is **mandatory**, not advisory. `backend.tf` declares an
  S3 backend with no defaults so `terraform init` cannot silently fall back to a
  local state file.
- The state bucket must itself be KMS-encrypted, versioned and access-restricted.
  It does not exist yet and is listed as a prerequisite in the inventory.
- Read access to Terraform state becomes equivalent to read access to the service
  credentials. That was not true of the SST layout.

If that trade is unacceptable, the alternative is to have Terraform create the
secrets with `ignore_changes = [secret_string]` and let host bootstrap perform a
one-time `put-secret-value --generate-random-password`, keeping generation out of
state entirely. That is a larger change to the host scripts and is **not**
implemented here.

## 6. What this handoff does not claim

Nothing here has been deployed. No AWS resource has been created, no control-plane
readback has been performed, and `pnpm check:work --item 1.2` has not passed.
This document and the import inventory are the *design* handoff; the sealed
evidence AC-1.2.b requires can only be produced by a real isolated-stage
deployment, which is gated on explicit operator approval.

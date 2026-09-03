# Agent infrastructure — Terraform

Terraform is the sole durable infrastructure-as-code substrate for
`stokd-cloud/agent` (axiom `AX-CLOUD-TERRAFORM`). The SST/CloudFormation layout
under `infra/api`, `infra/data` and `infra/bootstrap/empty-state.sst.config.ts`
is historical scaffold: reference-only input to the import inventory, never
deployed and never extended.

`infra/bootstrap/template.yaml` is the exception. It still owns the
account-level bootstrap resources — the workload permissions boundary, the
deploy role, the ECR repository, OIDC trust and the retained certificate — which
are referenced here but not managed here.

## Layout

| Path | Contents |
|---|---|
| `versions.tf` | Provider pinning; account- and region-locked AWS provider |
| `variables.tf` | Stage plus the exact image/commit digests, all validated |
| `locals.tf` | Stage identity (mirrors `infra/shared/constants.ts`) and the deploy-identity guard |
| `backend.tf` | Encrypted remote state — required, see below |
| `network.tf` | VPC, subnets, route tables, endpoints, security groups |
| `custody.tf` | KMS key and the two retained buckets |
| `secrets.tf` | The three generated service credentials |
| `mongo.tf` | MongoDB host, retained data volume, host bootstrap |
| `api.tf` | ECS cluster, task identities, service, load balancer, DNS |
| `manifest.tf` | The deployed-infrastructure manifest parameter |
| `envs/*.tfvars` | Per-stage inputs |
| `handoff/` | The AC-1.2.b handoff artifacts |

## Two stages

`source-val12` is the active stage. `restore-val12` is the restore target and
comes up in `restored_observation` mode: it reads the source stage's retained
backups read-only, and nothing restored into it can redispatch work.

## Encrypted state is required

Terraform state contains the generated service credentials. `backend.tf`
declares an S3 backend with no inline defaults, so `terraform init` cannot fall
back to local state. This is a deliberate difference from the SST scaffold and
is explained in [`handoff/BEHAVIORAL-CONTRACT.md` §5](handoff/BEHAVIORAL-CONTRACT.md).

## Usage

```bash
terraform init \
  -backend-config="bucket=stokd-agent-tfstate-167217327520" \
  -backend-config="key=work-1.2/source-val12/terraform.tfstate" \
  -backend-config="region=us-east-1" \
  -backend-config="kms_key_id=alias/stokd-agent-tfstate" \
  -backend-config="encrypt=true"

terraform plan -var-file=envs/source-val12.tfvars
```

Apply requires the bounded `stokd-agent-validation-deploy` role. A plan run as
any other principal fails its precondition before touching a resource.

## Status

Authored and `terraform validate`-clean. **Nothing has been deployed.** The
sealed evidence AC-1.2.b requires needs a real isolated-stage deployment and
direct control-plane readback, which is gated on explicit operator approval.

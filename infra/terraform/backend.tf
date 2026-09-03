# Terraform state for this project contains generated service credentials (see
# secrets.tf). Encrypted remote state is therefore a requirement, not a
# preference: a local state file would put those credentials on a developer
# disk in plaintext, which the SST scaffold deliberately avoided.
#
# Initialize with:
#   terraform init \
#     -backend-config="bucket=stokd-agent-tfstate-167217327520" \
#     -backend-config="key=work-1.2/<stage>/terraform.tfstate" \
#     -backend-config="region=us-east-1" \
#     -backend-config="kms_key_id=alias/stokd-agent-tfstate" \
#     -backend-config="encrypt=true" \
#     -backend-config="use_lockfile=true"
terraform {
  backend "s3" {}
}

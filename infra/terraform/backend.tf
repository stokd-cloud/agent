# Remote state, encrypted and versioned. No credential material reaches state —
# the secrets in secrets.tf are generated inside AWS — but state still describes
# the entire topology and must not sit on a laptop.
#
# Initialize with:
#   terraform init \
#     -backend-config="bucket=stokd-agent-tfstate-167217327520" \
#     -backend-config="key=work-1.2/<stage>/terraform.tfstate" \
#     -backend-config="region=us-east-1" \
#     -backend-config="kms_key_id=alias/stokd-agent-tfstate" \
#     -backend-config="encrypt=true"
terraform {
  backend "s3" {}
}

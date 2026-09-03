terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

# The Agent validation boundary is a single account and region. The provider is
# pinned to both and every plan/apply asserts the caller identity below, so a
# misconfigured profile fails before it can touch a resource.
provider "aws" {
  region              = local.region
  allowed_account_ids = [local.account_id]

  default_tags {
    tags = {
      Project   = "stokd-agent"
      Stage     = var.stage
      ManagedBy = "terraform"
    }
  }
}

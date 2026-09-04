# The Agent API, deployed by Terraform, standalone from the SST estate.
#
# It creates NO networking and NO database. selfactor's VPC/subnets/cluster are
# still SST-managed today and are about to be migrated to Terraform, so they are
# INPUTS here rather than hardcoded IDs or data-source lookups into SST state.
# When the Terraform estate lands, repoint these variables -- the module does not
# change. Storage is the existing Atlas cluster; nothing here provisions or
# reconfigures a database.

terraform {
  required_version = "1.5.7"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "5.100.0"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "vpc_id" {
  type        = string
  description = "VPC to run in. Currently SST-managed; repoint when Terraform owns it."
  default     = "vpc-0127d5ed7db4ce7b6"
}

variable "subnet_ids" {
  type        = list(string)
  description = "Subnets with egress. Public subnets today -- this VPC has no NAT."
  default     = ["subnet-0d4f1ba6c79a4cc8a", "subnet-0e8c708b1764350fd"]
}

variable "cluster_arn" {
  type        = string
  description = "ECS cluster to place the service in. Empty creates a dedicated one."
  default     = ""
}

variable "api_image" {
  type        = string
  description = "Exact image digest for the Agent API."
}

variable "mongo_secret_arn" {
  type        = string
  description = "Secrets Manager ARN holding the Atlas connection URI."
}

variable "database_name" {
  type    = string
  default = "selfactor_agents"
}

locals {
  name        = "selfactor-agents"
  account_id  = "167217327520"
  cluster_arn = var.cluster_arn != "" ? var.cluster_arn : aws_ecs_cluster.agents[0].arn

  tags = {
    Project   = "selfactor"
    Component = "agents"
    ManagedBy = "terraform"
  }
}

# Only when no existing cluster is supplied. Costs nothing when unused -- an ECS
# cluster is a free control-plane object.
resource "aws_ecs_cluster" "agents" {
  count = var.cluster_arn == "" ? 1 : 0
  name  = local.name
  tags  = local.tags
}

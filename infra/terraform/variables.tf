variable "stage" {
  description = "Agent validation stage. Only the two isolated validation stages are supported."
  type        = string

  validation {
    condition     = contains(["source-val12", "restore-val12"], var.stage)
    error_message = "unsupported Agent validation stage: must be source-val12 or restore-val12."
  }
}

variable "source_digest" {
  description = "Exact 40-character source commit SHA the deployed images were built from."
  type        = string

  validation {
    condition     = can(regex("^[a-f0-9]{40}$", var.source_digest))
    error_message = "source_digest must be the exact 40-character source commit SHA."
  }
}

variable "api_image" {
  description = "Exact private ECR digest for the Agent API image."
  type        = string

  validation {
    condition     = can(regex("^167217327520\\.dkr\\.ecr\\.us-east-1\\.amazonaws\\.com/stokd-agent-runtime@sha256:[a-f0-9]{64}$", var.api_image))
    error_message = "api_image must be an exact private ECR digest (no tags)."
  }
}

variable "mongo_image" {
  description = "Exact private ECR digest for the MongoDB runtime image."
  type        = string

  validation {
    condition     = can(regex("^167217327520\\.dkr\\.ecr\\.us-east-1\\.amazonaws\\.com/stokd-agent-runtime@sha256:[a-f0-9]{64}$", var.mongo_image))
    error_message = "mongo_image must be an exact private ECR digest (no tags)."
  }
}

variable "maintenance_image" {
  description = "Exact private ECR digest for the maintenance/backup runtime image."
  type        = string

  validation {
    condition     = can(regex("^167217327520\\.dkr\\.ecr\\.us-east-1\\.amazonaws\\.com/stokd-agent-runtime@sha256:[a-f0-9]{64}$", var.maintenance_image))
    error_message = "maintenance_image must be an exact private ECR digest (no tags)."
  }
}

variable "mongo_ami_id" {
  description = "Pinned AMI for the MongoDB host."
  type        = string
  default     = "ami-0fe74bfcad4fd6bd2"
}

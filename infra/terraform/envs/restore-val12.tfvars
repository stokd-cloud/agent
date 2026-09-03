# Restore target stage. Comes up in restored_observation recovery mode: records
# restored here are observation-only until reconciled, and nothing they contain
# may redispatch work.
stage = "restore-val12"

# Replace with the exact commit and image digests under validation.
# source_digest     = "0000000000000000000000000000000000000000"
# api_image         = "167217327520.dkr.ecr.us-east-1.amazonaws.com/stokd-agent-runtime@sha256:..."
# mongo_image       = "167217327520.dkr.ecr.us-east-1.amazonaws.com/stokd-agent-runtime@sha256:..."
# maintenance_image = "167217327520.dkr.ecr.us-east-1.amazonaws.com/stokd-agent-runtime@sha256:..."

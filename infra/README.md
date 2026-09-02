
# Standalone infrastructure boundary

This directory is owned by the independent Agent service. Later work provisions a dedicated Agent Mongo database, private versioned S3 bucket, KMS key, stateless API service, backup/restore policy, and streaming ingress. Work item 1.1 intentionally leaves deployment unsupported; importing any application package performs no provisioning, network connection, credential lookup, or process launch.

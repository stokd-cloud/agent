# Agent storage maintenance boundary

`stokd-agent-storage-maintenance <command>` is the only supported host entrypoint for storage maintenance. It constructs MongoDB URIs internally from non-secret endpoint metadata and file-backed credentials. Passwords, full MongoDB URIs, and receipt signing keys are never accepted on argv or printed.

Every invocation requires these environment variables:

- `AGENT_MAINTENANCE_CONFIG`: absolute path to canonical JSON, owned by the effective UID, mode `0400`.
- `AGENT_CREDENTIAL_FILE`: absolute path to canonical JSON, owned by the effective UID, mode `0400`.
- `AGENT_OUTPUT_PATH`: absolute path for the result. The CLI writes canonical JSON to a sibling temporary file, fsyncs it, atomically renames it, and leaves it at mode `0600`.
- `AGENT_RECEIPT_HMAC_KEY_FILE`: additionally required by `restore-offline` and `restore-finalize`; absolute, owner-controlled, mode `0400`.

The config has `schemaVersion:"1.0"` and a `command` equal to argv. Unknown, missing, or additional fields fail before the command runs. Standard output contains only `{schemaVersion,command,ok,outputWritten}`. The full non-secret result is written to `AGENT_OUTPUT_PATH`; errors expose only the stable error code and generic maintenance failure message.

## Frozen commands

All `environment` values select database `agent_<normalized-environment>`. `mongoHost` is exactly one `host:port`; `replicaSet` pins the one-member replica set. Resource identities contain exactly `artifactBucket`, `backupBucket`, `databaseVolumeId`, `kmsKeyArn`, and `mongoInstanceId`. Principal VersionId maps contain exactly `runtime`, `migration`, and `backup`.

| Command | Exact config fields after `schemaVersion,command` | Exact credential fields |
| --- | --- | --- |
| `migrate` | `environment,databaseName,replicaSet,mongoHost` | `migrationPassword` |
| `readiness` | `environment,databaseName,replicaSet,mongoHost` | `runtimePassword` |
| `validation-seed` | `environment,databaseName,replicaSet,mongoHost,operationId,payloadPath,artifactCustodyPath,sourceResourceIds,region` | `runtimePassword` |
| `validation-read` | `environment,databaseName,replicaSet,mongoHost,operationId,expectedPayloadSha256` | `runtimePassword` |
| `backup` | `environment,databaseName,replicaSet,mongoHost,mongodumpPath,workDirectory,sourceResourceIds,sourceSecretVersionIds,sourceResourceProofPath,admissionQuiesceProofPath,admissionQuiesceProbe,region,archiveObject,manifestObject` | `runtimePassword,backupPassword` |
| `restore-offline` | `manifestPath,manifestCustody,archiveCustody,localArchivePath,mongorestorePath,target,noAuthUri,maintenanceProof,migrationRoleName,targetSecretVersionIds,requireVersionedObjectCustody` | `runtimePassword,migrationPassword,backupPassword,maintenanceSessionToken` |
| `restore-finalize` | `manifestPath,manifestCustody,offlineReceiptPath,normalMongoHost,target,migrationRoleName,targetSecretVersionIds,sourceSecretVersionIds,region,targetArtifactBucket,targetArtifactKmsKeyArn` and, only for the Work 1.2 evidence fixture, `work12InjectedObjectFailure` | `runtimePassword,migrationPassword,backupPassword,sourceRuntimePassword,sourceMigrationPassword,sourceBackupPassword,priorRuntimePassword,priorMigrationPassword,priorBackupPassword` |

`validation-seed` accepts a 32-byte owner-controlled payload. Its custody file is exactly `{schemaVersion:"1.0",retained:{bucket,objectKey,versionId,eTag,sha256,byteLength,kmsKeyId,capturedAt},absentAfterBackup:{bucket,objectKey,versionId,eTag,sha256,byteLength,kmsKeyId,capturedAt}}`. The immutable keys are `agents/validation/<operationId>/retained.bin` and `agents/validation/<operationId>/absent-after-backup.bin`. The CLI HEAD-verifies both exact S3 VersionIds before atomically writing representative identity/profile, memory/history, pending wake/work/approval state, one previously succeeded work request with one accepted dispatch intent and one `executor.launch` audit event, and two initially ready artifact references. `validation-read` returns a stable source/restore semantic digest, the recovery/dispatch lock, exact source-to-current custody for both references, counts of one intent and one launch, and zero redispatches without launching work.

The retained-custody policy forbids deleting either validation object. To exercise the missing-version recovery branch without weakening that policy, the Work 1.2 scenario may add exactly `work12InjectedObjectFailure:{kind:"injected_missing_version",operationId:"valop_work12_durable_fixture",custody:{bucket,objectKey,versionId,eTag,sha256,byteLength,kmsKeyId,capturedAt}}` to `restore-finalize`. The custody must be the one manifest member at `agents/validation/valop_work12_durable_fixture/absent-after-backup.bin`, use the manifest source artifact bucket and KMS key, and contain 32 bytes. The S3 adapter first HEAD-verifies the full immutable source custody, leaves that source version present, performs no copy for it, and then returns the typed `missing_version` result. The restore report and restored fixture label this as `work12_injected_missing_version_after_exact_source_head`; evidence must not describe it as an AWS version that vanished.

`backup` requires a zero-desired/zero-running admission proof and performs fresh ECS identity/count probes before and after the full `mongodump --oplog`. It refuses publication if admission, resource identity, or ready-object custody changes. Archive and canonical manifest are written to versioned KMS S3 and return exact custody plus source principal secret VersionIds.

`restore-offline` runs only against a positively owned, stopped, loopback-only, random non-27017 standalone mongod over the retained target data path. It performs the full oplog restore, source-to-target namespace promotion, deletes restored principals/roles, creates only the target runtime/migration/backup principals, and emits an integrity-bound offline receipt. `restore-finalize` consumes that exact receipt after authenticated replica-set restart, proves source and prior-target credentials fail with MongoDB authentication code 18, restores or reuses exact S3 versions, and enters `restored_observation` with every execution record blocked from dispatch.

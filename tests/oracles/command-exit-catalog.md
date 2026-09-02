### Standalone command catalog
All commands accept `--json` except interactive `chat`; machine output is one versioned JSON response or a documented event stream, diagnostics go to stderr, and JSON never contains a credential. Names normalize with NFKC, trim, lowercase and collapsed whitespace for owner-local uniqueness; control characters and path separators are rejected. Display names preserve user spelling after validation. Creation slugs are bounded ASCII slugs with an agent-ID fallback; immutable IDs, not names or slugs, govern ownership.

| Proposed invocation | Required semantics and primary contracts |
|---|---|
| `stokd-agent login`; `logout [--host ID]` | Browser OAuth/cancel flow; revoke chosen host session only. AUTH-001/005, CLI-004. |
| `create NAME [--identity PATH] [--remit PATH]` | Read explicit local inputs, validate and create once; duplicate normalized name conflicts. AGENT-001, CLI-001. |
| `list [--archived]`; `show NAME_OR_ID` | Owner-only persisted state, deterministic name/ID resolution; archived visibility is explicit. AGENT-001, CLI-001. |
| `update NAME_OR_ID --file JSON_PATH --if-revision N` | Atomic validated profile/remit update; no editor or shell evaluation; stale revision conflicts. AGENT-002/004, CLI-002. |
| `archive NAME_OR_ID`; `restore NAME_OR_ID` | Apply the lifecycle table; repeat returns current state, never a duplicate agent. AGENT-003, CLI-002. |
| `chat NAME_OR_ID [--conversation ID]` | Attach forked DST; selected conversation must belong to agent/owner. TUI-001/003. |
| `files list NAME_OR_ID` | Return authorized artifact/version metadata; no public URLs. FILE-004, CLI-003. |
| `files add NAME_OR_ID PATH [--replace ARTIFACT_ID --if-version VERSION_ID]` | Explicit source path; new artifact or optimistic version replacement, resumable upload with checksum. FILE-001/002/003/005, CLI-003. |
| `files get NAME_OR_ID ARTIFACT_ID [--version VERSION_ID] --output PATH [--overwrite]` | Authenticated streaming download, checksum verification and atomic local rename; refuse existing destination unless overwrite was explicitly supplied. FILE-004, CLI-003. |
| `files delete NAME_OR_ID ARTIFACT_ID --if-version VERSION_ID` | Tombstone current version with conflict handling and retention disclosure. FILE-006, CLI-003. |
| `host start`; `host status`; `host stop` | Enroll/start independent supervisor; status is observational; stop drains/fences work and never silently deletes cloud state. RUN-005, OPS-007, CLI-005. |
| `import ROOT --dry-run --output MANIFEST_PATH` | Read-only classification and local review manifest, no cloud mutation. IMPORT-001, CLI-006. |
| `import --manifest MANIFEST_PATH --apply` | Apply only reviewed selections with unchanged source digests; resumable/idempotent. IMPORT-004/005, CLI-006. |
| `import status IMPORT_ID`; `import rollback IMPORT_ID --if-revision N` | Read durable batch state or reverse only unchanged import-owned writes/objects; conflicting later edits survive and are reported. IMPORT-006/007, CLI-006. |
| `export NAME_OR_ID --output PATH` | Consistent native export including selected versions; sanitized, integrity checked and atomically written without overwriting an existing path. FILE-009, CLI-007. |

Exit codes: 0 command/query succeeded; 2 usage/schema/invalid local input; 3 authentication/authorization; 4 missing resource; 5 revision/idempotency/name conflict; 6 runtime/network/quota/prerequisite failure; 7 unsupported capability/version. Querying a failed work request is a successful query (0) with failed state in its payload. Every catalog command owes positive and negative real executable probes under its CLI contract; domain assertions alone do not prove command parsing/routing.

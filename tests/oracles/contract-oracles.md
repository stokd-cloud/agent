### Oracle
O-SOURCE: pinned DST donor source and inherited source suites, with an explicit retained/replaced/unsupported surface ledger and expected diffs approved by this contract. Full native session semantics are intentionally replaced; rendering/input behavior retained by the ledger must pass source tests.
O-STATE: the lifecycle, authority and command tables below, frozen into expected fixtures before implementation; real Mongo replica-set records plus fault traces. Never infer success from a worker's prose.
O-CONTEXT: synthetic conversations with unique canary facts, corrections, scope labels and hostile text; actual captured DSH provider requests, exact source revisions and tokenizer counts. Expected inclusions/exclusions are frozen before implementation.
O-STORAGE: synthetic bytes and expected SHA-256 manifest, actual private S3 object/version reads and DB metadata, wrong-principal/revoked-stream/expired-upload negative probes.
O-MIGRATE: anonymized fixtures matching observed profile, telemetry and artifact categories; immutable source hashes and an independently authored expected mapping/exclusion manifest following the exact Import/export formats below. Personal data never enters public test fixtures.
O-FACTORY: real isolated Stokd task lifecycle plus durable external work ID, task/run/branch state and authenticated status readback; a task record alone does not prove launch or completion.
O-SURFACE: real CLI invocations and PTY recordings with independent HTTP/event observations; UI rendering, mock-only results or source inspection alone cannot pass behavior.
O-SECURITY: externally driven cross-principal, stale-host, path traversal, malicious tool, token replay and plugin-bypass probes; record both denial and absence of side effects.
O-RELEASE: isolated fresh clone/release artifact, exact Git SHAs/lockfiles, imports/process/network traces, independent cloud deployment and backup-restore drill.

Every Evidence entry below names a scenario in a proposed contract suite. Implementation must create these suites and scenario manifests; they do not exist today. Evidence is persisted under `evidence/<build-id>/<VAL-ID>/`, with command, exit code, source/lockfile SHAs, environment, sanitized traces and per-scenario verdicts. Unavailable real cloud/identity/provider/factory prerequisites are blocked, never mocked into a pass.

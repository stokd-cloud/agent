# Verification record

Validated on macOS arm64 with Node 24.15, pnpm 11.21 and Rust 1.93 during the
Stokd durable-agent integration task. All fixtures use temporary stores and
leave existing agents and Mongo collections untouched.

| Check | Result |
| --- | --- |
| `cargo fmt --manifest-path apps/agent-cli/Cargo.toml --check` | Passed |
| `cargo test --manifest-path apps/agent-cli/Cargo.toml --locked` | 11 domain tests passed |
| `cargo clippy --manifest-path apps/agent-cli/Cargo.toml --all-targets --locked -- -D warnings` | Passed, no warnings |
| `cargo build --manifest-path apps/agent-cli/Cargo.toml --locked` | Passed |
| `TMPDIR=/tmp DSH_TUI_LANG=zh pnpm build` | Clean TypeScript build and every donor build gate passed |
| `pnpm verify:package` | 1,439 files and all 30 entry targets passed |
| `pnpm verify:bun-package` | Packaged root, extension and bundled runtime imports passed |
| CI YAML and embedded JavaScript syntax | Passed after English translation |
| `pnpm verify:stokd` | Process transport, fallback, bounded inference, restart, approvals, cancellation, shims, cursor replay and donor renderer passed |
| `python3 scripts/verify-stokd-pty.py` | Actual named shim, chat, memory panel, cancellation, 40-to-32-column resize and terminal restoration passed in inline and fullscreen modes |
| `DSH_TUI_LANG=zh node --import tsx/esm scripts/repro-askpanel.tsx` | All passed |
| `DSH_TUI_LANG=zh node --import tsx/esm scripts/verify-askpanel-layout.tsx` | All passed |
| `DSH_TUI_LANG=zh node --import tsx/esm scripts/repro-toolcards.tsx` | All passed |
| `node --import tsx/esm scripts/verify-input-selection.tsx` | Passed during shared editor integration |
| English Stokd screen assertions | Passed at 100 and 40 columns, then resized to 32 |
| English scan of active runtime/help/primary guidance | No Chinese text found |

The long-conversation test completes 40 exchanges, keeps all 80 committed
messages, advances the rolling watermark, reopens the store and recalls the
first fact. Every generated prompt is checked against its byte limit. Crash
recovery distinguishes provisional text from committed messages; cancellation
is also exercised across independent engine instances.

Before the dedicated agent workload was introduced, a live check used
the machine's configured `models.workloads.chat` chain with
an isolated temporary agent. The primary attempt failed; fallback resolved to
`codex/gpt-5.6-sol`, used a 686-byte prompt and returned exactly
`Runtime connection verified.` The concrete model is evidence from that run,
not a compiled default. Existing conversations were not used for this check.

The actual Mongo PoC also imported successfully into a temporary SQLite store:
2 agents, 2 conversations, 6 messages and 5 memories. A second import returned
`alreadyImported: true`. The original collections and installed launchers were
not changed.

The model and embedding fixtures verify contracts, ordering and bounds; they
do not establish semantic recall accuracy or the factual quality of extraction
and summaries. Unix behavior was exercised locally; Windows was not exercised.
The retained donor fixtures use their historical Chinese locale, independently
of the Stokd entry's forced English interface.

See [the runtime contract](stokd-agent.md) for storage, migration, transport and
execution limits. The source is handed to Stokd's canonical lander through the
sanctioned feature branch; no protected-branch hook is bypassed.

## Dedicated agent workload follow-up

The runtime now reads `models.workloads.agent` for answers, extraction and
compaction. All 12 Rust tests, Clippy, the full TypeScript build, the process
integration and both real PTY modes passed after this change. The new routing
regression configures different `agent` and `chat` chains, proves only the
agent chain is selected, and checks missing/empty agent policies inherit only
`models.defaults`.

The public model inspection returned `workload: agent` and resolved the
operator's configured four-provider chain. The new global agent entry was
initialized from the existing chat model order; chat remains independently
configured. Stokd versions that filter unknown workload names also need the
companion workload registration in `apps/cli` before their config inspector
will display the entry. The Rust engine reads this entry directly.

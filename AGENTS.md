
# Cloud Agents repository guidance

This repository is the standalone, DST-derived implementation of Stokd Cloud Agents. Read this file before editing, and read `packages/tui/AGENTS.md` plus `packages/tui/ADAPTER.md` before changing the retained donor TUI.

- Keep `packages/runtime` independent of `packages/tui`, Mono implementation code, Stokd database clients, and any global DSH profile.
- `packages/protocol` is the versioned surface shared by TUI, headless, HTTPS, SSE, IPC, desktop, and future embedded callers. Unknown protocol majors and unknown state-changing events fail closed.
- Durable named coordinators do not perform external work. They submit typed work requests to disposable executors. Schedules and collaboration between durable named agents are outside this MVP.
- All unfinished runtime, storage, API, host, bridge, and CLI entrypoints must fail visibly with exit code 7. Never fall back to donor-local sessions, shell execution, storage, profiles, or model calls.
- Root verification registries are strict. Unknown items, targets, cases, empty selections, missing setup, mock substitution, and blocked targets fail nonzero. Work checks never seal VAL evidence.
- Preserve donor ancestry, MIT notices, source pin, submodule URLs, and gitlink SHAs. Do not rewrite or normalize the donor ledger.
- Generated `lib/` output is never committed. Use pnpm 11 and Node 24 in CI.

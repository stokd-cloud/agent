
# Stokd Cloud Agents

This repository builds durable named coordinators whose identity, memory, conversations, commitments, and artifacts live in the cloud. Every ordinary wake starts from mechanically assembled bounded context in a fresh DSH execution. Coordinators converse and dispatch typed work; disposable executors perform research, documents, and repository changes.

The repository is independently buildable from Stokd and Mono. Its first supported surface is the DST-derived terminal package in `packages/tui`. The UI consumes the same versioned protocol and application-service boundary used by headless and HTTP/SSE callers.

## Layout

- `packages/protocol`: versioned IDs, commands, events, errors, context, authority, host, work, artifact schemas, and transports.
- `packages/runtime`: UI-independent application service and coordinator runtime.
- `packages/dsh`: fresh DSH handle adapter.
- `packages/storage`: independent durable persistence boundary.
- `packages/tui`: pinned DST v0.9.3 donor source and tests.
- `packages/stokd-bridge`: optional factory/identity adapter.
- `apps/api`, `apps/host`, `apps/cli`: independently shipped service, supervisor, and command surfaces.
- `infra`: standalone cloud deployment definitions.
- `tests`: frozen contracts, oracles, donor parity ledger, and executable scenarios.

The MVP does not include schedules, peer collaboration between named agents, a desktop client, or a public SDK.

## Foundation verification

Use the repository-pinned Node.js 24.15.0 (`.nvmrc` and `.node-version`) and pnpm 11.25.0 (`packageManager`). For example, run `nvm install` followed by `corepack prepare pnpm@11.25.0 --activate` in this isolated checkout.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm -r build
pnpm verify:structure --item 1.1
pnpm check:work --item 1.1 --evidence evidence/work/1.1
```

These are implementation checks. They do not seal the project’s VAL contracts.

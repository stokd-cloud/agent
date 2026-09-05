# Adapter boundary and upstream contract

The Stokd host uses the Rust engine described in
[docs/stokd-agent.md](docs/stokd-agent.md). It does not boot the donor's Cordis
agent or session services. The following contract still governs the retained
upstream plugin and all shared components.

## Import boundary

Official `@deepseek-ai/*` packages may only be imported inside
`src/dsh-adapter/`. UI code (`screens/`, `components/`, `ink/`, `hooks/`,
`utils/`, `cc/`, and `stokd/`) reaches upstream through adapter facades,
including type re-exports in `src/dsh-adapter/types.ts` and runtime facades
such as `channel.ts` and `plugin.ts`.

`pnpm verify:boundary` scans every source file and fails on violations. It is
part of the build.

## Upstream contract

- Validated primary version: `0.1.2-alpha.2`; compatible versions:
  `0.1.1-rc.2`, `0.1.1-rc.1`, `0.1.0-rc.8`, `0.1.0-rc.7`, `0.1.0-rc.6`.
  `UPSTREAM_VALIDATED_VERSIONS` in `src/dsh-adapter/contract.ts` is authoritative.
  Feature gates use `installedMeetsVersion` across version families and
  prerelease channels so older hosts degrade gracefully.
- Peer range: `^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.2`.
- The blessed list checks full harness versions and framework major versions
  for Cordis/Schemastery.
- Drift warns during local startup; `pnpm verify:contract` fails in CI.

## Patch surface

`patch-surface.snapshot.json` records changes to official rows in
`cordis.patch.yml`:

- 24 disabled overrides: 23 unconditional; `command-goal` is disabled only
  when the shipped standard preset includes that command. This aligns alpha.2
  with web-app while preserving host `/goal` on rc.2. Web-app also has `hmr`.
- Eight configuration overrides, including session-telemetry-otel and
  plugin-package-inventory-deepseek to preserve TUI privacy defaults.
- 17 inserts: dsh-tui, working-activity, dsh-tui-auth, six plugin interop rows,
  and the storage/workspace/code-runtime/model-selection/preset/host-runner
  rows. Host-plane rows have dsh-tui-scoped IDs and disable themselves when
  official rows with the same ID/name already exist.

The subagent-model-selection row probes its own package subpath independently
of the optional inventory row. The preset roster restores CLI roots on rc.2;
alpha.2 uses the package's `includeShippedRoot` without duplicate loader IDs.

When upstream changes this surface, inspect the difference before regenerating
with `node --import tsx/esm scripts/verify-patch-surface.ts --snapshot`.
`pnpm verify:web-coexistence` combines the TUI and official web-app patches
with include semantics and detects duplicate loader IDs. If an adjacent
DeepSeek Harness checkout exists, it also checks that checkout's base and web
patches.

## Upgrading

1. Update the applicable `@deepseek-ai/*` packages with pnpm.
2. Run `pnpm build` and the regressions for the affected surface.
3. Review contract/patch differences before updating validated versions or
   regenerating snapshots.
4. Keep upstream compatibility changes inside the adapter where possible;
   preserve the shared UI and Rust-domain boundary.

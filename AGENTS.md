# AGENTS.md

This repository forks DSH TUI 0.10.0-beta.4 for Stokd durable agents. The active
entry is `stokd-agent`; its Rust engine owns agents, conversations, models,
retrieval, compaction, memory, artifacts, work and approvals. The TypeScript
host consumes that domain and reuses the donor renderer and components.
The upstream Cordis plugin remains available for compatibility.

Read [docs/contributing.md](docs/contributing.md) (the shared development
contract), [ADAPTER.md](ADAPTER.md) (upstream boundaries), and
[docs/stokd-agent.md](docs/stokd-agent.md) (the fork's runtime contract) before
changing behavior. The donor architecture is in
[docs/architecture.md](docs/architecture.md).

## Repository layout

```text
apps/agent-cli/rust/  Rust domain, storage, inference, retrieval and routing
apps/agent-cli/tests/ Domain acceptance regressions
src/stokd/           Rust transport, ordered projection and Stokd chat screen
bin/stokd-agent.js   Presentation-only launcher; named shims enter here
src/index.ts        Public upstream Cordis plugin entry and configuration schema
src/plugin.ts       Facade for upstream runtime registration and teardown
src/channel.ts      Facade for upstream session projection and actions
src/screens/        Upstream Chat interaction coordinator and status presentation
src/components/     Shared feature components and theme-aware primitives
src/themeCatalog.ts Built-in, static JSON and runtime plugin themes
src/ui.ts           Preferred renderer, themed Box/Text and TUI facade
src/ink/            Ported Ink renderer and terminal implementation
src/native-ts/      Ported Yoga layout engine
src/cc/             Terminal formatting and presentation helpers
src/dsh-adapter/    The only source directory allowed to import @deepseek-ai/*
src/*Prefs.ts       Upstream preferences and metadata under ~/.dsh-tui
.agents/skills/     Maintainer skills; excluded from the published package
presets/            Upstream shipped presets; unavailable from stokd-agent
bin/dsh-tui.js      Upstream direct command entry
vendor/dsh-std      Pinned vendored dependency
cordis.patch.yml    Upstream package overlay; order and row IDs matter
cordis.yml          Upstream bare Cordis/DSH composition example
scripts/            Regressions, probes and diagnostics; read headers first
docs/               English Stokd documentation and upstream reference material
lib/                Generated from src/; ignored by Git, never edit manually
```

## Commands

```sh
pnpm install --frozen-lockfile  # pnpm 11; Node ^22.19 or >=24 (CI: Node 24)
pnpm build:agent                # locked Rust build + full TypeScript build
cargo test --manifest-path apps/agent-cli/Cargo.toml --locked
pnpm verify:stokd               # Rust process + donor renderer integration
python3 scripts/verify-stokd-pty.py # bounded Unix terminal integration
pnpm compile                    # clean src/ -> lib/types/ compilation
pnpm build                      # compile + all donor build gates
pnpm verify:build               # gates without compiling again
pnpm verify:package             # tarball targets and entry smoke imports
pnpm smoke                      # general headless donor screen composition
```

There is no root `test` or `lint` script. Do not claim to have run one.
TypeScript compilation is the static gate; behavior uses focused regression
scripts. Most scripts run with plain `node` import `lib/types/`, so build first.
Source-importing scripts declare `node --import tsx/esm` in their headers.
Do not infer the input layer from the extension, or run every script as a
suite: some are interactive or unbounded forensic tools.

Shared rendering, Chat, prompt/question layout, tool cards, theme primitives,
and Ink changes require the three CI regressions listed in the contributing
guide. Also verify visible behavior in inline/fullscreen modes at narrow
widths. Documentation/workflow/YAML-only changes need no rebuild unless they
change TypeScript inputs.

## Boundaries and invariants

- Official `@deepseek-ai/*` imports belong only in `src/dsh-adapter/`. UI
  directories use the adapter facade. `pnpm verify:boundary` scans all source.
- The validated versions, peer ranges and blessed packages live in
  `src/dsh-adapter/contract.ts`. Drift warns locally and fails CI.
- Framework packages referenced by runtime or published types must be both
  peer and dev dependencies. Test-only framework references stay dev-only.
- Upstream overlay changes must keep `patch-surface.snapshot.json` in sync.
- `AX-AGENT-DURABLE-TRANSCRIPT-IS-TRUTH`: committed domain events are the
  transcript source of truth. Preserve ordered cursors, sequence anchors and
  call IDs. Never promote a provisional response into a committed fact in UI.
- `AX-AGENT-BOUNDED-CONFIGURED-INFERENCE`: every model call is bounded and uses
  the configured `models.workloads.chat` fallback chain. Compaction advances
  its watermark without deleting transcript. No hidden donor model calls.
- Domain mutations belong in Rust. CLI code only routes/presents. Projection
  belongs in `src/stokd/channel.ts`; interaction precedence belongs in Chat;
  terminal protocols, layout and frame differences belong in Ink.
- Shell prefixes, plugins/presets/reload, native model/session mutation,
  clipboard file extraction, local artifact writes, external editors and
  profile inheritance are unsupported in the Stokd host. Preserve explicit
  errors for unsupported commands.

## Development rules

- Edit source, never generated `lib/`, and do not commit generated output.
- Keep resource cleanup centralized. Cordis resources use `ctx.effect`; the
  Stokd host closes its transport and renderer through its exit funnel.
  Rendering failures exit nonzero. Restore raw mode, cursor, alternate screen,
  synchronized output, mouse and focus on every normal/error exit.
- Keep active TUI stdout quiet. Use opt-in stderr/debug paths such as
  `DSH_TUI_DEBUG` or `DSH_TUI_RENDER_LOG` for diagnostics.
- TypeScript is ESM with `.js` relative specifiers, type-only imports where
  appropriate, two spaces, single quotes and no semicolons. Use `unknown`
  with narrowing instead of introducing `any`. Do not mass-format Ink.
- Width means terminal display cells. Account for ANSI, combining characters,
  emoji and wide glyphs using the existing width/wrap/slice helpers.
- The Stokd interface, model instructions, help and primary documentation are
  English. Keep `README.md` and `README_EN.md` synchronized in English.
  Upstream locale dictionaries remain donor compatibility assets.
- Never print or persist credentials in diagnostics. Report only whether
  required credentials are available.
- Inspect status/diffs before editing and preserve other people's changes.
  Stage explicit paths; never `git add .` or `git add -A`. Never run destructive
  cleanup commands. Do not commit, tag, push or publish without user
  authorization. Governed work follows its sanctioned disposition and the
  canonical lander; never bypass a protected-target hook. Releases require a
  `v*` tag matching `package.json` exactly.

## Editing this file

`CLAUDE.md` is a symlink to `AGENTS.md`; edit this file. Keep rules self-contained
and link detailed contracts rather than duplicating them.

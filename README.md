# Stokd Agent

Persistent agents with a Rust engine and the forked DSH TUI
(`0.10.0-beta.4`). The existing Ink/Yoga renderer, prompt editor, Markdown
messages, scrolling, and terminal cleanup remain the UI foundation.

The agent owns its identity, remit, conversations, memories, artifacts, work
items, and approvals. SQLite stores ordered events and committed messages.
Compaction updates a summary watermark; it never deletes the transcript.
The CLI routes commands to the engine. The Stokd interface and help are English.

## Build and launch

Requires Rust 1.93+, Node 24, and the pnpm version pinned in `package.json`.

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:agent
node bin/stokd-agent.js create integrations-lead --remit "Coordinate integrations"
integrations-lead
```

`create` installs a collision-safe executable in `~/.local/bin`. That directory
must be on `PATH`. Use `node bin/stokd-agent.js chat integrations-lead` directly
otherwise. Add `--fullscreen` to use the alternate terminal screen.

Configure `models.workloads.chat` in Stokd first. Existing family selectors
such as `claude-opus` and `codex-sol` resolve against Stokd's provider discovery
cache. Refresh that cache with `stokd model list --refresh`. All inference,
including memory extraction and compaction, uses the configured ordered chain.

To bring existing Mongo PoC agents into the Rust store:

```sh
node bin/stokd-agent.js import-poc
node bin/stokd-agent.js chat integrations-lead
```

The import preserves IDs, message sequence anchors, summaries, and memories.
It reads the original database without modifying it, commits atomically, and
is idempotent. Import into an empty agent store before creating agents with
existing names. Stop the old readline process before taking the snapshot.

## In the TUI

| Surface | Commands / keys |
| --- | --- |
| Conversations | `/conversations`, `/new [title]`, `/select <id>`, Ctrl+B |
| Identity and remit | `/identity [text]`, `/remit [text]` |
| Memories | `/memories`; E to correct, F to forget; edits carry a revision |
| Artifacts | `/artifacts`, `/artifact <id>` |
| Work | `/work`, `/status` |
| Steering and cancellation | Enter while working, `/steer <text>`, `/cancel` |
| Approvals | `/approvals`; Enter reviews, D denies; Y confirms |
| Models | `/models` displays the resolved fallback chain |
| History | PgUp/PgDn scroll; Ctrl+P with an empty draft loads an older page; Ctrl+L returns to latest |
| Exit | `/exit`; Ctrl+C clears draft, cancels work, then exits |

Unsupported donor commands return an explicit error. The Stokd entry does not
mount donor shell commands, plugins, presets, reload, model/session mutation,
side questions, local file writes, external editors, or profile inheritance.
Artifacts are database records. Work items describe durable work status;
external task execution is explicitly unsupported in this runtime.

[Runtime, configuration, protocol, and limits](docs/stokd-agent.md)

## Verification

```sh
cargo test --manifest-path apps/agent-cli/Cargo.toml --locked
cargo clippy --manifest-path apps/agent-cli/Cargo.toml --all-targets --locked -- -D warnings
pnpm build
pnpm verify:package
pnpm verify:stokd
python3 scripts/verify-stokd-pty.py
```

The Stokd regression uses a local fake inference server and the actual donor
renderer. It checks fallback, bounded requests, restart, cancellation, approval
fencing, shims, ordered replay, and narrow inline/fullscreen interaction.
The donor's CI layout regressions remain required for shared editor changes.
On macOS, use `TMPDIR=/tmp` for donor socket probes; their existing questionnaire
fixtures require `DSH_TUI_LANG=zh`. The Stokd entry always selects English.

## Provenance

This is a fork of [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI), not a rewrite
of its renderer. Original MIT licensing and third-party notices are retained.
The native Cordis plugin remains in the source for upstream compatibility;
`stokd-agent` is the Rust-backed entry point.
[Upstream English documentation](docs/upstream-tui.md) describes that donor,
and [the contribution contract](docs/contributing.en.md) covers shared code.

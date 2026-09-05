# Rust agent runtime

The Stokd entry point forks DSH TUI 0.10.0-beta.4. It reuses the donor's
Ink/Yoga renderer, theme, prompt editing, user/assistant messages, Markdown,
scrolling, alternate screen, and terminal cleanup. It does not start Cordis
or the native DSH agent/session services.

```text
named shim / bin/stokd-agent.js
  -> Rust route.cli / route.slash
  -> apps/agent-cli/rust/domain.rs
  -> SQLite transactions + configured inference
  -> ordered replay / consistent snapshots
  -> src/stokd/channel.ts
  -> src/stokd/Chat.tsx + donor components
  -> src/ui.ts + ported Ink/Yoga
```

## Ownership and invariants

**AX-AGENT-DURABLE-TRANSCRIPT-IS-TRUTH.** The Rust engine owns all domain
mutations. Each conversation has an increasing event cursor. Message writes,
turn state, approvals, and resulting artifacts/work are committed in the same
SQLite transaction as their events. The TUI renders committed messages from
that log; provisional responses are separately labelled and never promoted
by recovery. Event replay is exclusive of `after`, ascending, and page-limited
to 200. Duplicate events are ignored; a gap triggers a fresh snapshot.

An OS advisory lock fences each active conversation across engine processes.
Independent conversations can run at the same time. A snapshot only recovers
an abandoned turn when its OS lock is free. Cancellation persists a fence,
stops inference, and prevents any later response/learning commit. A second
client can cancel another engine's turn; workers inspect the fence every
200 ms. Client EOF, SIGINT, and SIGTERM cancel owned work and close cleanly.

**AX-AGENT-BOUNDED-CONFIGURED-INFERENCE.** Every inference has a hard UTF-8 byte
budget. The four prompt layers are identity/remit, retrieved memories, rolling
summary, and up to 12 recent messages (matching the PoC's message-count window).
The current input and all framing count against that budget. Mandatory input
that cannot fit is rejected before being appended. Token counts are not
claimed to be exact: tokenization varies by provider.

Compaction consumes at most 20 eligible messages per turn. It advances
`throughSeq` only after the new summary is stored successfully. Old transcript
rows are never deleted. Large individual excerpts may be clipped within the
compaction prompt; their original contents remain available in history.

Memory extraction runs after the answer is committed and accepts up to six
facts explicitly attributed to the user. It and compaction use the same agent
fallback chain, owned by the engine. Failures appear as notices and do not
erase the committed answer. There are no donor side questions, title calls,
or other hidden inference paths.

Run these acceptance checks from the repository root:

```sh
cargo test --manifest-path apps/agent-cli/Cargo.toml --locked
pnpm verify:stokd
```

## Configuration

The engine reads `$STOKD_HOME/config.yaml` (`~/.stokd/config.yaml` by default)
and its `config.<env>.yaml` overlay. `env` defaults to `local`; `STOKD_ENV` can
pin the overlay. `STOKD_AGENT_CONFIG` instead selects one explicit YAML or JSON
document. No donor profile, preset, or project instructions are inherited.

```yaml
providers:
  - claude
  - codex
  - deepseek
  - grok
models:
  mode: all
  defaults: [codex-sol, deepseek-pro]
  workloads:
    agent: [claude-opus, default, grok-grok]
agent:
  promptBytes: 24000
  timeoutSeconds: 180
```

Configure or inspect this workload with `stokd model workload agent`; pass an
ordered list of selectors to set it, for example
`stokd model workload agent claude-opus codex-sol default`.
Use a Stokd version with the `agent` workload registered; older versions may
filter it from their config inspector. The Rust engine reads the entry directly.

`agent: {models: [...]}` is also accepted. The `default` sentinel expands in
place, keeps order, and deduplicates IDs. An absent/empty agent chain uses
`models.defaults`. The chat workload is independent and is never an implicit
agent fallback. An empty resolved chain fails explicitly on inference.
Family selectors resolve to concrete IDs from Stokd's
`cache/provider-models/*.json`, respecting configured providers and
`models.mode`. No model ID is compiled into the engine. Unresolved selectors
are shown by `/models` and recorded as failed attempts before fallback.

The configured order is authoritative. The first nonempty, bounded successful
response wins. Timeouts, HTTP failures, missing credentials/executables, empty
responses, and unsupported transports fall through to the next entry. Error
messages omit provider stderr, response bodies, and credentials.

| Provider | Transport |
| --- | --- |
| `claude` | Installed CLI, `--bare`, no tools/MCP/settings/session persistence, neutral temporary working directory |
| `codex` | Installed CLI, ephemeral, ignore user config/rules, shell/patch/multi-agent disabled, no MCP/web search, read-only sandbox, neutral working directory |
| `deepseek`, `grok`, `openai`, `openrouter` | OpenAI-compatible chat HTTP; respective `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` |
| `lmStudio` / `lmstudio`, `ollama` | Local OpenAI-compatible HTTP |
| Other configured provider | Explicit `endpoint` or trusted `command`/`args`; otherwise unsupported and fallback continues |

The CLI transports require versions supporting those isolation flags. They
never silently retry in an unrestricted mode. A custom command is a trusted
operator-supplied text transport: its own behavior is the operator's
responsibility. The engine does not interpret a shell command string. It passes
the bounded prompt on stdin, substitutes `{model}` in the argument array,
limits output, and kills the process group on cancellation or timeout.

An explicit endpoint/model needs no discovery cache:

```yaml
providers:
  - name: local-chat
    endpoint: http://127.0.0.1:1234/v1
models:
  mode: all
  workloads:
    agent: [local-chat/your-installed-model-id]
```

Provider entries may carry `port`, `apiKeyEnv`, or `apiKey` (including
`${ENV_NAME}`). Use HTTPS for remote endpoints; local HTTP is accepted.
Automatic redirects are disabled. Credentials never appear in `/models`.

The current standalone loader reads global/explicit configuration; it does
not merge Stokd's remote organization or repository/worktree overlays. Supply
an explicit resolved document through `STOKD_AGENT_CONFIG` when needed.

## Retrieval and memory editing

Hybrid retrieval adapts Stokd's normalized vector, lexical relevance, and
maximal marginal relevance approach. Offline recall uses deterministic hashed
vectors and rare-keyword weighting. To use actual semantic embeddings, point
to an OpenAI-compatible embedding service:

```yaml
agent:
  embedding:
    endpoint: http://127.0.0.1:1234/v1
    model: your-installed-embedding-model
    # apiKeyEnv: EMBEDDING_API_KEY
```

Queries and facts use the same embedder and dimensions. Requests are batched
in groups of 32. Revisions invalidate the embedding cache. If the embedding
service fails, recall falls back to lexical/hash retrieval with a notice.
Model weights and ONNX are not bundled into the Rust binary.

`/memories` shows complete facts and revisions. E fills the donor editor with
`/correct <id> <revision> <text>`; F asks for confirmation before forgetting.
Edits with stale revisions fail. Tombstones and correction history prevent
re-extraction of the same explicitly removed fact. These operations affect
saved memories; they do not erase the original statement from transcript or
summary. They are not a guarantee that an LLM cannot infer or restate that fact.

## Artifacts, work, and approvals

A model may answer with plain text or a JSON envelope:

```json
{
  "reply": "I drafted a route for review.",
  "actions": [
    {"kind": "artifact.create", "title": "Route", "content": "Follow the river north."},
    {"kind": "work.create", "title": "Review the route"}
  ]
}
```

Only those two action kinds are admitted, up to eight per answer. Proposals
are durable pending approvals. `/approvals` shows the action and full artifact
body before approval; Enter reviews, Y confirms, D denies. Applying an approval
and marking it resolved is one transaction. Repeated or cross-conversation
decisions fail. A proposal cannot execute a command, write a local artifact
file, mutate a donor session, or access a plugin.

Artifacts remain in SQLite and are readable through `/artifacts`. Work items
have `pending`, `running`, `blocked`, `complete`, or `cancelled` status. The
`work.update` domain command updates that status. This runtime does not dispatch
external Stokd tasks or claim an external executor is running.

Steering cancels an uncommitted generation, records the new user instruction,
and regenerates from durable state. Text-only transports do not expose true
mid-generation injection. If the reply was already committed, it stays in the
transcript and the steering starts a new turn. Tab queuing is unsupported;
use Enter to steer or wait for completion.

## Storage, migration, and installation

| Setting | Default / purpose |
| --- | --- |
| `STOKD_AGENT_HOME` | `$STOKD_HOME/agents`; SQLite database and conversation lock files |
| `STOKD_AGENT_BIN_DIR` | `~/.local/bin`; named shims |
| `STOKD_AGENT_CONFIG` | Optional explicit configuration document |
| `STOKD_AGENT_ENGINE` | Optional absolute Rust binary path |
| `STOKD_AGENT_MONGO_URI` | PoC import only; local Mongo by default |
| `STOKD_AGENT_DB` | PoC import only; `stokd-agent` by default |

The store directory is private on Unix. SQLite uses WAL, full synchronous
commits, foreign keys, and a busy timeout. A consistent snapshot binds its
cursor to the messages it contains. The TUI keeps at most 120 displayed
messages; older pages are read on demand. Conversation lists show the latest
200; artifacts, work and pending-approval panels show up to 100 records.

Stop the old PoC before importing to avoid taking a snapshot across its
non-transactional writes. The importer retains source IDs, sparse message
sequence anchors, memory facts and the latest summary watermark. It rejects
corrupt/orphaned records and name collisions atomically. Mongo credentials are
never written to the new database; source collections remain unchanged.
Existing shims pointing at
this checkout's old `apps/agent-cli/src/cli.mjs` now enter the new TUI; shims
pointing to a different checkout continue using that checkout.

The npm tarball includes Rust source and its lockfile. Compile the engine with
`cargo build --manifest-path apps/agent-cli/Cargo.toml --locked` after installing
the package from source/tarball. The launcher looks for a packaged binary in
`bin/`, then release/debug Cargo outputs; it never downloads or builds a
runtime during an interactive launch. This change does not publish a package
or replace the machine's existing `stokd-agent` command.

## Verification scope

The Rust domain tests cover 40-turn bounded prompts, summary watermarks,
restart/recall, concurrency, crash recovery, cancellation, approvals,
revision fencing, import atomicity and command rejection. The process/TUI
regression uses a local fake model and embedding HTTP server and the actual
donor renderer in inline/fullscreen modes at 100/40 columns with a resize to
32. These establish transport and domain behavior, not the factual quality of
model-generated memories or summaries.

The bounded Unix PTY regression launches the installed named shim against an
isolated fixture, opens chat and memories, cancels a running model process,
resizes from 40 to 32 columns, and verifies clean exit with canonical input,
echo, and the normal screen restored. Run it after building both runtimes:

```sh
python3 scripts/verify-stokd-pty.py
```

## Decisions for this fork

- Use SQLite for the local Rust domain so an agent can restart without a
  separately running Mongo service. Preserve the Mongo PoC through an explicit,
  read-only, atomic import; never rewrite its source collections.
- Keep the existing TypeScript/React TUI and port domain behavior into Rust.
  The transport boundary replaces the harness service boundary while retaining
  the donor renderer and editor.
- Use a provider-neutral byte budget instead of pretending different providers
  share an exact tokenizer. Preserve all original transcript records.
- Keep artifact proposals and work state durable, with explicit approval and
  no external executor. Additional execution adapters can be added behind
  domain commands without changing the CLI or renderer.
- Keep the installed machine launcher unchanged during development. The new
  entry can be invoked directly from the built checkout; existing shims for a
  different checkout continue to launch that checkout until installed there.

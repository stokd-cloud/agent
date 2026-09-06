---
name: project-start
description: >-
  Start an existing Stokd project (or create one from a PRD path or
  description) as a supervised engine run, and stay on as the user's
  go-between until the project is terminal. Use only when the user explicitly
  invokes /project-start, $project-start, names the project-start skill, or asks
  to start a Stokd project.
invocation: explicit
---

# Project Start

The project engine is the driving force. `stokd project start --autonomous`
launches a supervised, mechanical loop that plans and walks every phase to
completion, dispatches its own workers and validators, survives reboots,
reroutes on provider exhaustion, and comes back to a human in exactly two
situations: a stop the plan DECLARED, and a decision the work genuinely cannot
make. It cannot be talked into ending early, because it is not a conversation.

The invoking agent does not implement the project. It launches the engine and
then remains the user's go-between for the whole run — relaying what the engine
needs, carrying the user's answers back, answering the user's questions from
the record, and refusing to end its own turn while the run is alive.

## 1. Resolve or create the project

- Treat input as an existing reference only when `stokd project get <hash>`
  succeeds. Run `stokd project view --hash <hash>` and read the stored PRD,
  contract assertions, phases, declared stops, validation commands, and current
  status. Never proceed from a title, summary, or list row alone.
- Otherwise preserve the full request with `stokd project create --file <path>`
  or `stokd project create <description>`. With no input, use the bare create
  verb for editor authoring. Capture the returned hash and verify it with get
  and view before continuing.
- Preserve the persisted plan. Missing, ambiguous, or blocked prerequisites are
  blockers to resolve, not permission to invent a smaller project.

## 2. Hold this session to the run

Register the obligation BEFORE launching. While any item is unchecked the
Stop-gate refuses to let this turn end, which is the only thing that keeps a
chat session on a multi-hour run:

```bash
stokd autonomous start --request "drive project <hash> to a terminal state" --items "
engine launched for <hash> and confirmed live with stokd project wait
every declared stop relayed to the user verbatim and answered with stokd project answer
project <hash> reached done, or the engine's exact blocker was reported to the user
stored validations run from the project worktree and the truthful disposition declared
"
```

Discharge an item with `stokd autonomous done <n>` only when it is genuinely
true. Never discharge the last item while `stokd project wait` reports the run
alive.

## 3. Launch the engine

```bash
stokd project start --autonomous <hash>
```

It detaches, prints the supervisor pid, and returns. Always pass
`--autonomous`: without it the engine runs in the foreground of this tool call
and blocks the session, and `-i` opens a steerable child that is a second
orchestrator. If admission is refused (autonomous concurrency is at its cap),
report the exact message once, then retry after `stokd project wait` on the
projects ahead of it, or when the user frees a slot.

### Land targets (`--target`)

When the invocation carries `--target`, forward it verbatim
(`stokd project start --autonomous <hash> --target <value>`). It records which
branches the work is eligible to land into if landing is separately permitted
and admitted (AX-CLI-LAND-TARGET-SELECTION-AT-START):

- `--target <a>,<b>` — eligible for exactly these branches, in listed order.
- `--target all` — every configured `git.land.target` (the default).
- `--target none` — disable landing for this item; it stops at dev-complete.

Omit the flag when the user did not pass one. Omission means "leave whatever the
record already selected alone", which is NOT the same as `--target all`.

## 4. Be the go-between until the run is terminal

Loop on one blocking call:

```bash
stokd project wait <hash> --timeout 1800
```

- **Exit 3** (timed out, still running): call it again in the same turn. Do
  not narrate between waits; a progress message ends the turn.
- **Declared stop** (`phase state: hold`): quote the question to the user
  exactly as printed, and wait for THEIR answer — this is the only human stop.
  Then `stokd project answer <hash> --note "<their answer>"`, then
  `stokd project advance <hash> --autonomous`, then wait again.
- **Attention needed**: `stokd project attention <hash>` lists the items and
  their evidence. Decide what the evidence decides
  (`--decide <ITEM>=retry|continue|patch|abort`), then
  `stokd project advance <hash> --autonomous` and wait again. Bring a decision
  to the user only when it would change what the project IS, not how it is
  built.
- **Parked or blocked**: the output names the cause (a provider limit, a
  missing tool, an admission failure). Fix it when it is within reach, then
  `stokd project advance <hash> --autonomous`. Otherwise report the exact
  reason once.
- **The user asks something mid-run**: answer from `stokd project view`,
  `stokd project report <hash>`, and `stokd project attention <hash>`. When
  only the orchestrator can answer, ask it — `stokd peer message
  phase-orch-<phase project id> --ask "<question>"` then `stokd peer
  wait-reply` — and continue waiting. Never stop the run to answer a question.
- **Done**: go to step 5.

The engine's own worktree is the workspace `stokd project view --hash <hash>`
reports; this session does not edit files in it while the run is alive.

## 5. Finish honestly

From the project worktree, run the stored validations plus required
regressions. Declare `stokd disposition dev_complete --hash <hash>` only when
the project is code-complete and the branch is committed and recoverable
upstream; otherwise use the matching truthful quit-class disposition. Do not
invent a disposition when no qualifying tracked work exists. Confirm
`land_state` before saying the project landed; disposition does not trigger or
prove merge. Then discharge the final obligation item and give the user the
closeout: what shipped, what was decided at each stop, and anything skipped.

## Prohibited

- Implementing, editing, or validating the project's work items in this
  session. The engine's workers own the code; this session owns the user.
- `stokd project start` without `--autonomous`, `-i`/`--interactive`,
  `stokd project phase-run`, `stokd project one-shot`, or invoking a provider
  CLI to run the project.
- Ending the turn while `stokd project wait` reports the run alive, or
  narrating progress between waits.
- Asking the user anything the record, the evidence, or the orchestrator can
  answer.

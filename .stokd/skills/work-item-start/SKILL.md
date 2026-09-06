---
name: work-item-start
description: >-
  Resolve and execute a Stokd task, project, or todo in the current visible
  agent session. Use only when the user explicitly invokes /work-item-start,
  $work-item-start, names the work-item-start skill, or asks to start a generic
  Stokd work item.
invocation: explicit
---

# Work Item Start

The invoking agent remains the visible, user-facing root orchestrator. Resolve
the work-item kind, then execute its protocol inline in the current session.
Use only provider-native in-session subagent tools for bounded delegation; do
not hand the workflow to a Stokd child or provider CLI.

## 1. Resolve kind and identity

- When the caller supplies `task`, `project`, or `todo`, use that kind.
- For an unqualified reference, make read-only resolution attempts with
  `stokd task get <ref>`, `stokd project get <ref>`, and `stokd todo get <ref>`. Proceed
  only when exactly one record resolves; report an ambiguous or missing identity
  instead of guessing.
- For new prose, classify the requested outcome: a bounded code/config change is
  a task; dependency-ordered multi-phase work is a project; a checklist/grouping
  is a todo. Create it with the matching create verb, capture the returned hash,
  and verify the full record before work begins.

## 2. Execute the matching in-session protocol

### Task

Read `stokd task view <hash>`, preserve its complete contract, submit a
judge-ready plan through `stokd mode task --task <hash>`, follow the approved
worktree directive, and implement from failing regression through stored
validation.

### Project

Read `stokd project view --hash <hash>`, preserve the full PRD, assertions,
phases, dependencies, ceremony tier, and declared stops, then submit the
dependency-aware plan through `stokd mode project --project <hash>`. Execute
unblocked phases in order and honor only persisted stops.

### Todo

Read `stokd todo view <hash>`, map ordering and prerequisites, and execute each
linked or newly created task/project with the matching mode attachment above.
Persist each verified checklist transition with `stokd todo update <hash>`, and
complete the todo only after all actionable children resolve.

### Land targets (`--target`)

When the invocation carries `--target`, forward it verbatim to the `stokd`
command you invoke (`stokd mode task|project ... --target <value>`, or `stokd work-item start <hash> --target <value>`). It records which branches the work is
eligible to land into if landing is separately permitted and admitted
(AX-CLI-LAND-TARGET-SELECTION-AT-START):

- `--target <a>,<b>` — eligible for exactly these branches, in listed order.
- `--target all` — every configured `git.land.target` (the default).
- `--target none` — disable landing for this item; it stops at dev-complete.

Omit the flag when the user did not pass one. Omission means "leave whatever the
record already selected alone", which is NOT the same as `--target all`.

The invoking agent owns decomposition, user-facing progress, synthesis,
validation, and lifecycle truth as root orchestrator. Provider-native subagents
may own independent bounded lanes with explicit files, dependencies, and checks;
they never replace the root or share one mutating worktree unsafely.

## 3. Finish honestly

For task/project work that changed git-tracked files in a non-primary worktree,
use `stokd disposition dev_complete --hash <hash>` only when the persisted
contract is green and the branch is committed and pushed; otherwise use the
matching quit-class disposition, which may preserve a local handoff when a push
is not valid. Do not invent a disposition without
qualifying tracked work. Verify `land_state` before claiming merge; disposition
does not trigger it. For a todo, verify every child and the final todo record.

## Prohibited dispatches

Do not use any task/project launch, resume, advance, interactive-child, or
one-shot execution verb. Do not invoke another provider process to perform the
work. Foreground execution is still a second orchestrator.

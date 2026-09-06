---
name: todo-start
description: >-
  Execute a Stokd todo checklist from the current visible agent session. Use
  only when the user explicitly invokes /todo-start, $todo-start, names the
  todo-start skill, or asks to start a Stokd todo.
invocation: explicit
---

# Todo Start

The invoking agent remains the visible, user-facing root orchestrator. A todo
is a persisted checklist and dependency map, not an execution engine. Execute
its actionable children in this current session and use only provider-native
in-session subagents for bounded delegation.

## 1. Resolve or create the todo

- Resolve an existing reference with `stokd todo get <hash>` and `stokd todo
  view <hash>`. Read every checklist item, repository assignment, linked work
  item, prerequisite, ordering cue, and completion state.
- Otherwise preserve the input with `stokd todo create --file <path>` or `stokd
  todo create <markdown>`. With no input, use the bare create verb. Capture the
  returned hash and verify it with get and view.
- Build an explicit dependency/order map. Skip completed items; do not start a
  child whose prerequisite is incomplete.

## 2. Execute actionable children

- For a linked task, read its full task record and attach the responsible
  current agent session with `stokd mode task --task <hash>` before mutation.
- For a linked project, read its full PRD and attach the responsible current
  agent session with `stokd mode project --project <hash>` before mutation.
- For an unlinked code/config item, create a task or project according to its
  actual scope, verify its hash, attach with the matching mode command, and
  preserve the todo relationship in progress notes.
- Perform non-code operator items directly only when they are safely authorized
  by the todo and need no separate governed code work item.

### Land targets (`--target`)

When the invocation carries `--target`, forward it verbatim to the `stokd`
command you invoke (`stokd todo start <hash> --target <value>`). It records which
branches each child is eligible to land into if landing is separately permitted
and admitted
(AX-CLI-LAND-TARGET-SELECTION-AT-START):

- `--target <a>,<b>` — eligible for exactly these branches, in listed order.
- `--target all` — every configured `git.land.target` (the default).
- `--target none` — disable landing for each child; work stops at dev-complete.

Omit the flag when the user did not pass one. Omission means "leave whatever the
record already selected alone", which is NOT the same as `--target all`.

A todo never lands itself, so its selection propagates to every incomplete
linked child task/project when the todo starts. Pass `--target` on the todo
rather than repeating it per child.

The invoking agent is the root orchestrator: it owns ordering, user updates,
synthesis, and checklist state. Independent children may be assigned to
provider-native subagents, but every mutating lane needs its own sanctioned work
item/worktree, explicit ownership, and validation contract. Never assign two
agents to the same mutating lane.

Within each child, use the matching in-session task/project protocol: failing
regression first, root-cause implementation, stored validation, commit, push,
and truthful disposition. Complete prerequisites before dependents.

## 3. Persist checklist progress

After each verified child, preserve the full checklist and update its state via
`stokd todo update <hash> --file <path>`, then confirm with `stokd todo view
<hash>`. Never reconstruct or overwrite the todo from a truncated list view.
Run `stokd todo complete <hash>` only when every actionable item is complete or
explicitly resolved, then verify the final record.

## Prohibited dispatches

Do not use any task/project launch, resume, advance, interactive-child, or
one-shot execution verb, and do not invoke a provider CLI. A todo must not hide
work inside a separate Stokd workflow.

---
name: task-start
description: >-
  Start an existing Stokd task or create and execute one in the current visible
  agent session. Use only when the user explicitly invokes /task-start,
  $task-start, names the task-start skill, or asks to start a Stokd task.
invocation: explicit
---

# Task Start

The invoking agent remains the visible, user-facing root orchestrator for the
entire task. Attach governance to the current session, implement here, and use
only provider-native in-session subagent tools for bounded delegation. Never
transfer ownership to a child Stokd or provider process.

## 1. Resolve or create the task

- Treat input as an existing reference only when `stokd task get <hash>`
  succeeds. Then run `stokd task view <hash>` and read the complete stored
  objective, acceptance criteria, validation commands, components, and
  prerequisites. The title or list row is not a sufficient execution contract.
- Otherwise preserve the user's full input with `stokd task create --file
  <path>` or `stokd task create <description>`. With no input, use the bare
  create verb so the operator can author it in the editor. Capture the returned
  hash, then verify it with both get and view before continuing.
- If a prerequisite is unresolved or incomplete, report that concrete blocker;
  do not weaken or silently replace the stored contract.

## 2. Bind this session

Build a complete judge-ready plan from the stored record. It must name the
objective, binary acceptance criteria, runnable validation commands, affected
components, prerequisite state, and TDD order. Submit that plan on stdin:

```bash
stokd mode task --task <hash> <<'PLAN'
<complete stored-contract plan>
PLAN
```

### Land targets (`--target`)

When the invocation carries `--target`, forward it verbatim to `stokd mode task`
(`stokd mode task --task <hash> --target <value>`). It records which branches
this task is eligible to land into if landing is separately permitted and
admitted (AX-CLI-LAND-TARGET-SELECTION-AT-START):

- `--target <a>,<b>` — eligible for exactly these branches, in listed order.
- `--target all` — every configured `git.land.target` (the default).
- `--target none` — disable landing for this item; it stops at dev-complete.

Omit the flag when the user did not pass one. Omission means "leave whatever the
record already selected alone", which is NOT the same as `--target all`.

Do not mutate files unless the mode switch approves. Follow the returned
worktree directive, move this current session into that worktree, and verify the
repository root and pinned branch before editing. Never implement in a primary
checkout when an isolated worktree was assigned.

## 3. Execute as root orchestrator

- The invoking agent owns decomposition, user updates, synthesis, validation,
  and lifecycle state.
- Use provider-native subagents only for genuinely independent research,
  implementation, or review lanes. Give each lane a bounded deliverable, explicit
  file ownership, dependencies, and the warning that other agents share the
  checkout. Never assign two mutating agents to the same files or worktree.
- Add or run a failing regression first, implement the smallest root-cause fix,
  then run the stored validations and proportionate regressions.
- Synthesize subagent results in the invoking agent. A child result is evidence,
  not task completion.

## 4. Finish honestly

If this run changed git-tracked files in a non-primary worktree, it owes a
truthful disposition before Stop. Declare `stokd disposition dev_complete
--hash <hash>` only after the stored contract is green and the task branch is
committed and pushed; otherwise use the matching structured quit-class
disposition, which may preserve a local handoff when a push is not valid. Do not
invent a disposition when no qualifying tracked work exists. Verify `land_state`
before saying the change is landed; disposition does not trigger or prove merge.

## Prohibited dispatches

Do not use any task/project launch, resume, advance, interactive-child, or
one-shot execution verb. Do not invoke a provider CLI to run the work. Those
paths create a second workflow and hide implementation from the user's current
conversation.

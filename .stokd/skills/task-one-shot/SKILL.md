---
name: task-one-shot
description: >-
  Create and execute a governed Stokd task in one shot, or execute an existing
  task hash through the same workflow. Use only for /task-one-shot,
  $task-one-shot, or an explicit request to invoke this skill.
---

# Task One Shot

Delegate the complete workflow to `stokd task one-shot` exactly once.

- With no input, run `stokd task one-shot --vim` so the CLI opens its editor.
- With input, pass every argument directly after `stokd task one-shot`.
- Relay the CLI output and exit status without independently recreating any
  creation, governance, worktree, execution, review, integration, or completion
  step.

The CLI owns the workflow. Do not parse its output to launch a second task or
perform lifecycle changes manually.

---
name: task-create
description: >-
  Create a Stokd task from free-form text, a file, or editor input. Use only
  when the user explicitly invokes /task-create, $task-create, or asks to run
  the task-create skill.
---

# Task Create

Delegate task creation to the Stokd CLI exactly once.

- With no input, run `stokd task create` and allow the CLI to open its editor.
- With input, pass every argument directly after `stokd task create`.
- Relay the returned hash, embellishment state, output, and exit status without
  parsing them to launch another workflow.

The CLI owns input and reference parsing, structured-description detection,
repository resolution, prerequisites, validation, persistence, and optional
worktree setup. Do not recreate any of that logic in this skill.

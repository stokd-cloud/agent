---
name: todo
description: >-
  Capture, list, view, update, or complete Stokd todos, including daily and
  weekly task groups. Use only for /todo, $todo, or an explicit request to use
  the Stokd todo skill.
---

# Todo

Use the canonical `stokd todo` command. A todo is a checklist grouping layer;
it can organize sequential or independent tasks across repositories, but it is
not an execution engine.

## Routing

- No input: run `stokd todo`.
- Input beginning with `create`, `complete`, `delete`, `get`, `move`, `note`,
  `start`, `update`, or `view`: pass all input directly after
  `stokd todo`.
- Any other text: treat it as capture content and run
  `stokd todo create <input>`.

For multiline or detailed content, preserve the user's text through `--file` or
the bare editor instead of reconstructing it. Relay the CLI output and exit
status.

The CLI owns timespan expansion, checklist parsing, repository inference,
prerequisite references, merging, identity, and persistence. Do not create
tasks from todo items unless the user separately requests that product action.

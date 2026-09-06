---
name: project-create
description: >-
  Create and persist a Stokd project from editor input, a readable PRD or text
  file, or an inline problem description. Use only when the user explicitly
  invokes /project-create, $project-create, names the project-create skill, or
  asks to create or register a Stokd project.
invocation: explicit
---

# Project Create

Delegate project creation to one CLI call:

```bash
stokd project create [OPTIONS] [INPUT...]
```

Choose only the arguments for that single invocation:

- empty input: run the bare command.
- readable file: add --file and pass the path resolved from the current
  workspace.
- inline input: forward it unchanged, keeping supported options before `--`
  when a separator is needed.

The CLI owns editor input, PRD detection or generation, phase and contract
parsing, persistence, and local project artifacts. Relay its output and exit
status. Do not retry after a possibly successful persistence step.

After a successful create, verify the returned hash without recreating it:

```bash
stokd project get <hash>
```

Report the persisted identity and the local `.stokd/projects/<slug>/` artifact
when present. Include `stokd project start <hash>` as the next command, but do not run it.
This skill never starts the project.

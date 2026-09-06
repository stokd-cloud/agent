---
name: help
description: >-
  Answer Stokd installation, configuration, governance, provider, skill,
  session, task, project, todo, and troubleshooting questions. Use when the
  user asks how Stokd works or needs help operating its CLI and local runtime.
---

# Stokd Help

Answer from the shipping Stokd surface rather than a provider-specific memory.

## Procedure

1. Identify the Stokd area and whether the question asks for documentation,
   current state, diagnosis, or a configuration change.
2. For current command behavior, run `stokd --help` and
   `stokd <command> --help`. Prefer this live output over remembered syntax.
3. For installed documentation, inspect the relevant file under
   `~/.stokd/docs/`. In this repository, use the corresponding source under
   `docs/` when the installed copy is absent.
4. For current configuration, use `stokd config show`,
   `stokd config get <key>`, or `stokd config schema`. Never infer effective
   state from one provider's private configuration file.
5. For skills, use `stokd skill list --all`, `stokd skill --help`, and the
   canonical workspace or global `SKILL.md` selected by Stokd precedence.
6. For sessions, use `stokd session --help`, `stokd session list`, or
   `stokd session find`. For governance, use the `governance` skill rather than
   editing any override file.
7. When the user requests a supported change, use the canonical Stokd command
   and follow governance. Otherwise provide the shortest accurate command and
   explain its observable result.

Keep provider-specific setup scoped to that provider and label it clearly. Do
not direct a user to modify another provider merely because it is the current
agent runtime.

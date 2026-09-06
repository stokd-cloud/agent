---
name: create-skill
description: >-
  Create or scaffold a provider-neutral Stokd skill and deploy it to configured
  providers. Use when the user asks to create a skill or runs /create-skill.
---

# Create Skill

Create the skill through Stokd's canonical store, never through the current
provider's private skill directory.

## Procedure

1. Resolve a lowercase hyphen-case name under 64 characters and choose scope:
   workspace by default, personal only when the user requests global reuse.
2. Capture concrete triggers, inputs, workflow, deterministic resources,
   failure behavior, and observable validation. Keep `SKILL.md` concise.
3. Write a complete proposed `SKILL.md` to a temporary file. Use only `name`
   and `description` in portable frontmatter unless Stokd invocation policy is
   intentionally being set.
4. Create the canonical skill:
   - Workspace:
     `stokd skill create --name <name> --source-file <path>`
   - Personal:
     `stokd skill create --global --name <name> --source-file <path>`
5. If the skill should be explicit or disabled, set it with
   `stokd skill policy <name> explicit|disabled` and the matching `--global`
   scope when needed.
6. Run `stokd skill deploy` so configured provider-native surfaces receive the
   canonical content and adapted invocation metadata.
7. Verify with `stokd skill list --all` and report the canonical path, scope,
   invocation policy, and provider deployment results.

Native trees such as `.grok/skills`, `.claude/skills`, and `.codex/skills` are
generated projections, never authoring targets. Do not claim cross-provider
availability merely because the canonical `SKILL.md` exists; deployment and
inventory are separate checks.

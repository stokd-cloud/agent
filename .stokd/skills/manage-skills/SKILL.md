---
name: manage-skills
description: >-
  Create, update, remove, deploy, inspect, or change invocation policy for a
  provider-neutral Stokd skill. Use for /manage-skills, $manage-skills, or a
  request to manage a skill across configured Stokd providers.
---

# Manage Skills

Use Stokd's canonical skill store and provider fan-out. Never treat one
provider's native skill directory as the source of truth.

## Procedure

1. Resolve the action, canonical lowercase hyphen-case name, scope, invocation
   policy, and complete `SKILL.md` content.
2. Keep the skill provider-neutral. Put repeatable deterministic behavior in
   `scripts/`, detailed domain material in `references/`, and output resources
   in `assets/`. Do not add auxiliary README or changelog files.
3. Preview when overwriting, disabling, or removing a skill unless the user
   already made that exact action explicit.
4. Create or update from a complete source:
   - Workspace: `stokd skill create --name <name> --source-file <path>`
   - Personal: `stokd skill create --global --name <name> --source-file <path>`
   - Update: add `--force`
5. Set invocation policy when requested:
   `stokd skill policy <name> auto|explicit|disabled`
   Add `--global` for the personal copy. Prefer `explicit` for costly,
   destructive, or operator-triggered workflows.
6. Deploy the canonical workspace and global catalog with
   `stokd skill deploy`. This step is required after workspace creation because
   canonical storage and native provider materialization are separate concerns.
7. Remove with `stokd skill remove <name>` or
   `stokd skill remove <name> --global`, matching the canonical scope.
8. Verify the result with `stokd skill list --all`. Use `--json` for a
   machine-readable inventory.

Stokd owns canonical paths, configured-provider discovery, metadata adaptation,
materialization, removal, and invocation policy. Do not recreate that behavior
inside `.grok/skills`, `.claude/skills`, `.codex/skills`, or any other native
provider tree; those are generated projections, never authoring targets.

---
name: skill-audit
description: >-
  Audit Stokd canonical and provider-native skill copies for digest drift,
  stale disabled copies, invocation policy, unmanaged copies, and
  provider-specific assumptions. Use only for /skill-audit, $skill-audit, or
  an explicit request to audit skill distribution.
---

# Skill Audit

Run the bundled read-only auditor. It inventories skill files and never
creates, deploys, changes, or removes a skill.

## Procedure

1. Resolve the script using the first existing path:
   - `$STOKD_SKILLS_DIR/skill-audit/scripts/skill_audit.py`
   - `.stokd/skills/skill-audit/scripts/skill_audit.py`
   - `~/.stokd/skills/skill-audit/scripts/skill_audit.py`
   - `apps/cli/templates/skills/skill-audit/scripts/skill_audit.py`
2. Run:
   `python3 <script> --workspace <repository-root> --json`.
   Add `--strict` only when the caller wants a non-zero exit for actionable
   drift or stale-copy findings.
3. Report, in priority order:
   - a disabled canonical skill still present in a provider surface;
   - a provider copy whose portable bundle digest differs from canonical;
   - a provider-only unmanaged skill;
   - provider-specific filesystem or tool assumptions;
   - missing copies for provider roots that already exist.
4. Include canonical scope, invocation policy, content digest, portable bundle
   digest, copy path, and finding code. Distinguish workspace-over-global
   precedence from verified provider deployment.

Do not run `stokd skill sync`, `stokd skill deploy`, policy changes, or file
cleanup unless the user explicitly requests a separate repair action after
reviewing the audit.

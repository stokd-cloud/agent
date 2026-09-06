# Conflict resolution (land-worktrees)

The full protocol lives in its own skill: **`.stokd/skills/conflict-resolution/`**.

When Phase 6's sync-merge (`git merge origin/<default>`) hits conflicts, invoke `/conflict-resolution` — or follow `../../conflict-resolution/SKILL.md` directly — and return here once its Phase 5 gates are green.

Summary of what that skill enforces, so the rules stated in `SKILL.md` are unambiguous:

- **Mechanical first.** `rerere`, `zdiff3`, one-sided (false) conflicts, lockfile regeneration, and union-mergeable files are resolved with **no model at all**. On a branch 100+ commits behind, this is most of the work.
- **Deterministic triage.** `scripts/conflict-triage.sh` scores the remaining conflicts from git plumbing — structural class, path criticality, and how many hunks changed on *both* sides — and picks a model tier: `worker` (docs), `codeReview` (ordinary code), `escalation` (mission-critical, structural, or heavily diverged). Escalation is one-way.
- **Hand-merge, never wholesale.** `-X ours` / `-X theirs` at merge level is forbidden — it silently discards non-conflicting hunks you never reviewed. Per-file `--ours`/`--theirs` only for the classes the playbook names.
- **Both-sides survival gate.** Markers gone is not "resolved". Every symbol, guard, and call either side introduced must be present in the result or explicitly justified as superseded.
- **Preserve on failure.** If the top tier cannot decide safely, stop with backup refs and both sides intact and report the specific hunk plus each side's intent. Landing may fail; work may not be lost.

For a worktree that is far behind, the per-worktree sync in Phase 6 is exactly where this pays off — run it there rather than deferring conflicts to the PR merge, where you lose the local context needed to resolve them.

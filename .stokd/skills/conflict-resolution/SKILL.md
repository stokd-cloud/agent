---
name: conflict-resolution
description: Resolve git merge/rebase conflicts so any worktree can land, no matter how deep. Runs 100% mechanically until a real conflict exists, then triages difficulty deterministically and routes to the cheapest model workload that can safely decide — economy for docs, mid for ordinary code, top tier for mission-critical or heavily-diverged conflicts. Use whenever a merge, rebase, cherry-pick, or `stokd land`/`shove` stops on conflicts, when the user says "resolve the conflicts", "land it anyway", "this worktree won't merge", or when a landing attempt reports `failed`.
---

# Conflict Resolution

Land **any** worktree. The prime directive: **no feature, fix, or intent is ever silently lost.** A merge that drops one side's work is worse than a merge that fails loudly, because the failure is visible and the loss is not.

The design principle is: **be mechanical for as long as possible, then spend exactly as much model as the conflict actually deserves.**

## Prior art (and why this exists)

There is no canonical, battle-tested standard for this. What exists, and what we took:

- **git `rerere`** — reuse recorded resolutions. Genuinely canonical, and the single highest-leverage mechanical win on repeated rebases. We turn it on. ([docs](https://git-scm.com/docs/git-rerere))
- **git merge drivers / `.gitattributes`** — per-path merge policy (`union`, `binary`, custom). Canonical, underused. We use it for append-only files.
- **Rover** (2026) — context-aware resolution using AST/CFG/dependence analysis with a *tiered confidence model*: auto-resolve when changes are provably independent, heuristics for moderate cases, LLM escalation for semantic ambiguity. The tiering idea is sound; the heavy program analysis is not portable across a polyglot monorepo. We keep the tiering, and substitute git plumbing + the both-sides signal for the program analysis. ([arXiv](https://arxiv.org/pdf/2605.17279))
- **CONGRA** (2024) — benchmark showing conflict difficulty is dominated by *structural class*, not conflict size. Drives our structural penalties. ([arXiv](https://arxiv.org/pdf/2409.14121))
- **LLMinus** — embeds historical resolutions for semantic recall. This is `rerere` with fuzzy matching; we use real `rerere` and leave fuzzy recall out until it earns its place. ([LWN](https://lwn.net/Articles/1053714/))
- Existing agent skills (Agensi's "merge conflict resolver", assorted others) — advertise "objective criteria" for Accept Ours / Accept Theirs / Manual Merge but never publish them. Unfalsifiable, so unusable.

The gap all of them share: **none decides how much model to spend.** That is the part this skill adds, and it is the part that makes unattended landing affordable.

## The five phases

Run them in order. Never skip ahead — every phase makes the next one cheaper.

### Phase 0 — Preflight (mechanical, no model)

```bash
git config rerere.enabled true          # reuse recorded resolutions
git config rerere.autoupdate true
git config merge.conflictStyle zdiff3   # MANDATORY: exposes the merge base
```

`zdiff3` is not cosmetic. Without the `|||||||` base section you cannot tell a *false* conflict (only one side moved; context drift) from a *real* one (both sides rewrote the same logic). That single distinction drives the entire difficulty model. Default `diff2` markers make every conflict look maximally dangerous.

**Optional but cheap — predict before you touch anything.** `git merge-tree` computes the merge in memory and reports conflicts without creating a merge state, dirtying a worktree, or requiring a checkout. Use it to decide whether a worktree can land, and in what order, before committing to anything:

```bash
git merge-tree --write-tree origin/<default> <branch>
# exit 0 + a bare tree OID  ⇒ merges clean
# exit 1 + stage lines      ⇒ conflicts; each conflicted path appears as
#                             stage 1/2/3 lines (base/ours/theirs)
```

Count **paths, not lines** — one conflicted file yields up to three stage lines. If the branch isn't fetched locally you get `not something we can merge`; fetch it first.

This is safe to run against worktrees other agents are actively using, since it touches nothing.

Then snapshot both sides so nothing is unrecoverable:

```bash
git update-ref refs/backup/conflict/<branch>/<utc> <branch>
git rev-parse HEAD MERGE_HEAD   # record; these are your ours/theirs anchors
```

### Phase 1 — Merge mechanically

```bash
git fetch origin
git merge origin/<default>      # merge INTO the branch. Never rebase a shared branch.
```

If it succeeds: done, zero model spent. That is the common case and it must stay free.

**Never use `-X ours` or `-X theirs` at the merge level.** They apply to every hunk in the merge, silently discarding non-conflicting work you never looked at. Per-file `git checkout --ours/--theirs` is acceptable *only* for the specific classes named in `references/playbook.md`.

### Phase 2 — Triage (mechanical, no model)

```bash
.stokd/skills/conflict-resolution/scripts/conflict-triage.sh --json
```

The scorer reads the live conflicted index and emits, per file: structural class, criticality, hunk count, **both-sides-changed hunk count**, whether it is mechanically auto-resolvable, and a score. It never mutates the repo.

```
file_score = criticality×2 + both_sides_hunks×3 + one_sided_hunks + structural_penalty
```

Auto-resolvable files score 0 — they are handled in Phase 3 with no model at all.

Full scoring tables, tier thresholds, and hard escalators: **`references/triage.md`**.

### Phase 3 — Mechanical auto-resolution (no model)

Resolve everything that has a deterministic right answer *before* any model is invoked:

| class | action |
|---|---|
| `rerere` hit | already resolved — just verify and stage |
| lockfiles, generated code, snapshots, `dist/` | take either side, then **regenerate** from merged inputs. Never hand-merge — a hand-merged lockfile is an invalid lockfile |
| `CHANGELOG`, `.gitignore`, `CODEOWNERS` | union both sides, dedupe, preserve order |
| import/use blocks | union + dedupe + re-sort |
| formatting-only divergence | take either side, run the formatter |
| one-sided hunks (`ours == base` or `theirs == base`) | take the side that moved — this is a false conflict |

That last row matters more than it looks: on a branch 180 commits behind, most "conflicts" are context drift, not disagreement. Recipes in `references/playbook.md`.

Re-run the triage script after this phase. The score you route on is the **post-mechanical** score.

### Phase 4 — Route to the right model tier

| tier | when | workload | model tier |
|---|---|---|---|
| **T0** | score 0 — nothing left | *none* | — |
| **T1** | docs/prose/comments, score < 7 | `worker` | Economy |
| **T2** | ordinary code, score 7–24 | `codeReview` | mid |
| **T3** | score ≥ 25, **or any hard escalator** | `escalation` | Strong |

These are the repo's existing canonical workload slugs (`apps/cli/src/llm_routing.rs`) — no config change required.

**Hard escalators** jump straight to T3 regardless of score, because these are exactly the conflicts where a cheap model destroys work invisibly:

- any mission-critical path (auth, billing, payments, secrets, migrations, schema, IaC, CI workflows, governance/landing code)
- any **modify/delete** conflict — one side deleted what the other developed; this is an intent clash no textual merge can model
- any **binary** or **submodule** conflict — a wrong submodule pointer silently rewinds an entire repo
- ≥ 5 both-sides hunks in a single file — the two sides are rewriting the same logic
- more than 10 conflicted files — broad divergence

Escalation is one-way. A tier may raise itself mid-resolution when it discovers the conflict is worse than triage estimated; it may **never** lower itself.

### Phase 5 — Verify, then and only then commit

A resolution is not done because the markers are gone. Gates, in order — all must pass:

1. **No markers anywhere**: `git diff --check` and `grep -rn '^<<<<<<<\|^>>>>>>>\|^|||||||' -- <resolved files>`
2. **Parses / typechecks**: repo build or typecheck green (`pnpm compile` here).
3. **Both-sides survival** — the gate that actually prevents loss. For each conflicted file, diff the resolution against *each* side's contribution:
   ```bash
   git diff $(git merge-base HEAD MERGE_HEAD) HEAD      -- <file>   # what ours added
   git diff $(git merge-base HEAD MERGE_HEAD) MERGE_HEAD -- <file>  # what theirs added
   ```
   Every symbol, branch, guard, and call introduced by either side must be present in the result, or its absence must be *explicitly justified* (genuinely superseded, not merely inconvenient). Silence is not justification.
4. **Tests** relevant to the touched files pass.

Only then `git add` and commit. If a gate fails, fix it or escalate a tier — never commit past a red gate.

## Escalation terminus

If T3 cannot resolve safely, do **not** guess and do **not** abandon. Stop with everything preserved (backup refs, both sides intact, merge state or a clean abort) and report exactly: which file, which hunk, what each side intended, and what decision is missing. That report is what a human or a fresh agent picks up. Landing may fail; work may not be lost.

## Hard rules

- Never `git stash`, `git reset --hard`, `git checkout -- .`, `git restore .`, `git clean -f`.
- Never `-X ours` / `-X theirs` at merge level.
- Never `--no-verify` on push. Pre-push hooks are the last gate.
- Never resolve by deleting code you do not understand. Not understanding it is grounds to escalate, not to delete.
- Never switch branches inside a worktree to "fix" a merge.

## References

- `references/triage.md` — scoring tables, tier thresholds, escalators, tuning
- `references/playbook.md` — per-class mechanical recipes and per-tier resolution protocols
- `scripts/conflict-triage.sh` — the deterministic scorer

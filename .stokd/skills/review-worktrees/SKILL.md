---
name: review-worktrees
description: Methodically examine ALL of a repo's (or every machine repo's) non-primary git worktrees with the same analysis rigor as land-worktrees — inventory, overlap, superseded detection, active-agent exclusion, fork-point order — then checkpoint-commit and push uncommitted work only in worktrees with no agent currently running, and present an ordered Review Plan of what to do with each repository and worktree for user approval. Never lands, merges, rebases, or removes. Use whenever the user asks to "review the worktrees", "review all worktrees", "worktree review plan", "what should we do with the worktrees", "review worktrees across repos", or wants a plan of outstanding worktree work before landing. Also use for a read-only "which worktrees need attention" report.
invocation: auto
---

# Review Worktrees

Examine every non-primary worktree with the same analysis rigor as `/land-worktrees`, then stop. The only mutation this skill may perform is checkpoint-commit + push of uncommitted (and unpushed) work in worktrees that have **no agent currently running**. Everything else is a recommended next action in an ordered Review Plan that **always** waits for user approval.

Prime directive: **NO work is ever lost.** Never touch an ACTIVE worktree. Never land, merge, rebase, or remove.

This skill is not `stokd worktree review` (that CLI dispatches reviewer agents and persists COMPLETE/INCOMPLETE assessments). Do not invoke that command unless the approved plan explicitly asks for it as a *later* step.

## Model routing

- **Orchestrator (this session) — Opus-class or better.** Classification, superseded calls, repo/worktree order, and recommended next actions live here. If the session is running below Opus, say so and suggest `/model` before the mutating phase — proceed only if the user says so.
- **No finish/land workers.** This skill does not make trees compile, open PRs, or merge. Do not spawn per-worktree "dev-complete" subagents.

## Hard safety rules (apply to every phase)

- **Never** `git stash`, `git reset --hard`, `git checkout -- .`, `git restore .`, or `git clean -f`.
- **Never switch branches** inside an existing worktree.
- **Never land, merge to the default branch, rebase, open or merge a PR, delete a branch, or remove a worktree.** Those belong to `/land-worktrees` or `stokd worktree land` after the user approves that next step.
- **Never** `--force` push or `--no-verify`. Pre-push hooks must pass.
- **Never mutate a worktree classified ACTIVE** — not even a status-refresh that writes, and not a commit or push.
- If anything unexpected appears (rebase/merge in progress, detached HEAD with unpushed commits, lock files), classify NEEDS-HUMAN, leave that tree intact, and continue with the others.

## Phase 0 — Preflight (read-only)

**Scope**

- Default: the current git repository (`git rev-parse --show-toplevel`).
- All-repos when the user says "all repos", "all worktrees", "every repository", or is not inside a git repo: discover machine repos the same way `stokd worktree review --all-repos` does (walk known worktree hubs such as `/opt/worktrees/*` and each repo's `git worktree list --porcelain`). Deduplicate by git common dir.

For each repo:

1. `git worktree list --porcelain` — full inventory. Identify:
   - the **primary worktree**: checked out at the repo's canonical main path (or the bare hub's default). If the primary is not on the default branch, note it — never "fix" it.
   - the **default branch**: `git remote show origin | sed -n 's/.*HEAD branch: //p'` (fall back to `main`).
   - the **repo slug**: `owner/repo` from `origin` when present; otherwise the directory basename.
2. `git fetch origin --prune` so comparisons are against current `origin/<default>`.
3. Exclude from mutation consideration: the primary worktree, the worktree this session is running in, and bare/locked entries. Still list them in the plan as excluded-with-reason.

## Phase 1 — Examination (read-only)

For each candidate worktree, collect:

| field | how |
|---|---|
| repo slug | from Phase 0 |
| path, branch, HEAD | porcelain output |
| fork point from default | `git merge-base origin/<default> <branch>` + its commit date |
| commits ahead/behind | `git rev-list --left-right --count origin/<default>...<branch>` |
| unpushed | `git -C <wt> rev-list --count @{u}..HEAD` if upstream exists; otherwise the branch has never been pushed |
| diff footprint | `git diff --stat origin/<default>...<branch>` (files touched) |
| uncommitted state | `git -C <wt> status --porcelain` (staged, unstaged, untracked all count as work) |
| already landed? | `git cherry origin/<default> <branch>` — all `-` ⇒ every commit is upstream. Also check content: `git diff origin/<default>...<branch>` empty ⇒ landed even if hashes differ |
| in-progress git state | `.git/MERGE_HEAD`, `rebase-merge/`, `index.lock` in the worktree's gitdir |
| work item | `task/<slug>` or `project/<slug>` on the branch, when present |

**Overlap matrix** (within each repo): intersect touched-file sets of every pair. Overlapping pairs are conflict risks — they inform review order.

**Superseded detection** (judgment, not just plumbing):

- *Landed*: content-diff vs `origin/<default>` is empty, or `git cherry` shows all commits upstream → LANDED.
- *Superseded by a sibling*: touched files are a subset of another worktree's, and reading the diffs shows the other tree contains an equivalent-or-newer version of the same change → SUPERSEDED-BY:<branch>. When in doubt, do **not** mark superseded.
- Anything with uncommitted work is never LANDED/SUPERSEDED outright — inspect the uncommitted delta first.

## Phase 2 — Active-agent exclusion (read-only)

Classify a worktree ACTIVE if ANY signal says an agent or human is working in it:

1. **Live processes rooted there**: `ps -axo pid,command | grep -Ei 'claude|agent|codex|gemini|agy|cld|grok'`, then for hits `lsof -p <pid> 2>/dev/null | grep cwd` — cwd inside the worktree ⇒ ACTIVE.
2. **Recent file churn**: writes under the worktree in the last 30 minutes (exclude `node_modules` and `.git`) ⇒ likely ACTIVE.
3. **Git locks**: `index.lock` or in-progress merge/rebase ⇒ ACTIVE.
4. **Orchestrator registries** if present (`stokd session list`, `stokd worktree` tooling, agent-link `list_agents`): a live session bound to the worktree ⇒ ACTIVE.

ACTIVE worktrees are listed as excluded-with-reason and left completely untouched.

## Phase 3 — Review Plan + HARD GATE

Order **repositories** first, then worktrees inside each repo.

**Repo order:** oldest fork-point among that repo's reviewable (non-ACTIVE, non-primary) trees, then more reviewable trees first, then slug. Independent repos stay in that order.

**Worktree order** (inside a repo): fork-point commit date, oldest first. Break ties / adjust:

- If A and B overlap and B's diff builds on files A rewrote heavily, put the simpler/smaller one first.
- Independent (non-overlapping) trees keep pure fork-point order.

**Classifications**

| class | meaning |
|---|---|
| PUSH | idle, and dirty and/or unpushed — this skill will checkpoint-commit (if dirty) and push after approval |
| REVIEW | idle, unique unlanded work, already on origin — recommend a later land/integrate/code-review |
| LANDED | content already on `origin/<default>` — recommend cleanup later; do not clean |
| SUPERSEDED-BY:\<branch\> | equivalent-or-newer sibling exists — recommend leave or later cleanup; do not clean |
| ACTIVE-excluded | agent/human live — leave completely |
| SESSION-excluded | this session's worktree or the primary — listed, never mutated |
| NEEDS-HUMAN | unexpected git state, hook-blocked, detached+unpushed, or judgment the orchestrator cannot make safely |

**Recommended next action** (plan of record — not executed by this skill):

- `push` — the only action this skill will take after approval
- `land` — later via `/land-worktrees` or `stokd worktree land`
- `integrate` — later via `stokd worktree integrate` (lapsed dirty/unmerged)
- `assess` — later via `stokd worktree review --worktree <path>` (persisted COMPLETE/INCOMPLETE)
- `hold` — already pushed; wait
- `cleanup` — already landed; user must approve cleanup separately
- `leave-active` — do not touch
- `needs-human` — blocked; say exactly what is blocking

**Produce the Review Plan** — one section per repo in repo order, then one line per worktree: order, path, branch, classification, ahead/behind, unpushed count, uncommitted-file count, overlaps, recommended next action, and a one-line why.

**HARD GATE:** this is the last read-only moment. **Always** show the plan and wait for an explicit go-ahead before any commit or push — even if the user already said "review everything". Do not auto-proceed. If they asked only for a report/dry-run, stop here and deliver the plan with no mutation.

## Phase 4 — After approval only: checkpoint + push idle dirty/unpushed

Execute **only** the approved PUSH rows. Skip any tree the user struck from the plan.

For each approved PUSH tree, immediately before mutating:

1. Re-run Phase 2 on that tree (race: an agent may have started). If now ACTIVE, skip and report.
2. If dirty: `git -C <wt> add -A && git -C <wt> commit -m "wip(review-worktrees): checkpoint uncommitted work"`. Untracked files count — `add -A`, not `add -u`. Skip the commit if clean.
3. Backup ref: `git update-ref refs/backup/review/<branch>/<UTC-timestamp> <branch>`.
4. `git -C <wt> push -u origin <branch>` (never `--no-verify`, never `--force`).
5. Push/hook failure ⇒ reclassify NEEDS-HUMAN, leave the local commit intact, continue with the others.

Do not commit or push SESSION-excluded or ACTIVE trees. One tree failing never aborts the rest.

## Phase 5 — Final report

Deliver:

- Pushed (repo / branch → remote), with backup refs created
- Skipped ACTIVE / SESSION-excluded (with the signal that excluded them)
- NEEDS-HUMAN (with exactly what is blocking)
- The Review Plan of record: repo order + per-tree recommended next action
- Explicit no-loss confirmation: every branch that existed at Phase 0 is still on disk; approved idle dirty/unpushed trees are on origin and in `refs/backup/review/*`
- Explicit: this skill did **not** land, merge, rebase, or remove anything

Stop. Do not start `/land-worktrees` or `stokd worktree review` unless the user now asks.

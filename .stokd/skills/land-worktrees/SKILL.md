---
name: land-worktrees
description: Methodically examine, finish, and land ALL of a repo's non-primary git worktrees onto main — analyzing overlap and complexity, detecting worktrees already landed or superseded, excluding worktrees other agents are actively using, ordering by fork point, bringing each tree to dev-complete in parallel, then landing them one at a time (commit → push → PR → merge) and cleaning up the landed worktrees. Use this whenever the user asks to "land the worktrees", "land all worktrees", "bring the worktrees home", "consolidate worktrees", "merge all the branches/worktrees", or wants outstanding worktree work swept onto main. Also use for a read-only "worktree landing report" or "which worktrees can land" — run only the analysis phases for that.
---

# Land Worktrees

Sweep every non-primary worktree of the current repo onto main: analyze, classify, order, finish in parallel, land sequentially, clean up. The prime directive is **NO work is ever lost** — every decision below bends toward that.

## Model routing & escalation

Two tiers, by design:

- **Orchestrator (this session) — Opus-class or better.** All judgment lives here: classification, superseded calls, landing order, conflict decisions, and unblocking stuck workers. If the session is running on a model below Opus (check your system prompt), tell the user this skill's orchestration is designed for Opus and suggest switching (`/model`) before the mutating phases — then proceed only if they say so.
- **Workers (Phase 5 subagents) — Sonnet.** Pass `model: "sonnet"` on every per-worktree dev-complete Agent/Workflow call. Finishing a tree is well-scoped execution work; Sonnet is fast and cheap for it.

**Escalation loop** — workers must ask for help instead of thrashing: each worker prompt includes the instruction that if it is blocked or unsure (ambiguous half-finished code, a failing test it can't diagnose after ~3 focused attempts, anything tempting it toward a forbidden git command), it stops and ends its turn with a structured help request — `HELP-NEEDED: <worktree> | blocker: <what> | tried: <attempts> | question: <specific ask>` — rather than guessing or burning tokens. Workers run in the background, so the orchestrator sees each result as it lands: when a result is a HELP-NEEDED, the orchestrator (Opus) investigates the blocker itself (read the code, reproduce the failure), decides, and replies via `SendMessage` to that same worker — its context is intact, so send targeted guidance ("the intent of the half-written function is X; finish it as Y", "that test fails because Z landed on main; sync first") and let it continue. Escalate to the user only when the orchestrator itself can't decide safely (that's the NEEDS-HUMAN classification). A worker may ask for help multiple times; reclassify to NEEDS-HUMAN when guidance stops making progress rather than looping forever.

## Hard safety rules (apply to every phase)

- **Never** `git stash`, `git reset --hard`, `git checkout -- .`, `git restore .`, or `git clean -f`. These destroy uncommitted work.
- **Never switch branches inside an existing worktree.** Each worktree keeps its branch; main is updated only in the primary worktree (or via fetch on the bare repo).
- Before ANY mutating phase, create backup refs (Phase 4). A branch is deletable only after its content is verified reachable from main.
- Prefer `trash` (or `git worktree remove`, which refuses when dirty) over `rm -rf` for removing worktree folders.
- Conflicts are **hand-merged hunk by hunk** — never resolved wholesale with `-X ours` / `-X theirs` (see `references/conflict-resolution.md`).
- If anything unexpected appears (a worktree in a rebase/merge state, detached HEAD with unpushed commits, lock files), stop work on that tree, report it, and continue with the others.

## Phase 0 — Preflight (read-only)

1. `git worktree list --porcelain` — full inventory. Identify:
   - the **primary worktree**: the one checked out at the repo's canonical main path (or the bare hub's default). If the primary is NOT on the default branch, note it — never "fix" it silently; land to `origin/<default>` regardless.
   - the **default branch**: `git remote show origin | sed -n 's/.*HEAD branch: //p'` (fall back to `main`).
2. `git fetch origin --prune` so all comparisons are against current `origin/<default>`.
3. Confirm `gh auth status` works (needed for PRs). If not, report and offer plain merge-to-main push instead.
4. Exclude from consideration: the primary worktree, the worktree this very session is running in, and bare/locked entries.

## Phase 1 — Examination (read-only)

For each candidate worktree, collect into a table:

| field | how |
|---|---|
| branch, HEAD | from porcelain output |
| fork point from default | `git merge-base origin/<default> <branch>` + its commit date |
| commits ahead/behind | `git rev-list --left-right --count origin/<default>...<branch>` |
| diff footprint | `git diff --stat origin/<default>...<branch>` (files touched) |
| uncommitted state | `git -C <wt> status --porcelain` (staged, unstaged, untracked all count as work) |
| already landed? | `git cherry origin/<default> <branch>` — all `-` ⇒ every commit is upstream. Also check content: `git diff origin/<default>...<branch>` empty ⇒ landed even if hashes differ |
| in-progress git state | presence of `.git/MERGE_HEAD`, `rebase-merge/`, `index.lock` in the worktree's gitdir |

**Overlap matrix**: intersect the touched-file sets of every pair of worktrees. Overlapping pairs are conflict risks — they inform ordering (Phase 3) and mean the later tree must be re-synced against main after the earlier one lands.

**Superseded detection** (needs judgment, not just plumbing):
- *Landed*: content-diff vs `origin/<default>` is empty, or `git cherry` shows all commits upstream → classify LANDED.
- *Superseded by a sibling*: its touched files are a subset of another worktree's, and reading the actual diffs shows the other tree contains an equivalent-or-newer version of the same change → classify SUPERSEDED-BY:<branch>. When in doubt, do NOT mark superseded — land both and let the merge dedupe; a redundant merge is recoverable, a skipped change is not.
- Anything with uncommitted work is never LANDED/SUPERSEDED outright — the uncommitted delta must be inspected first.

## Phase 2 — Active-agent exclusion (read-only)

Exclude a worktree if ANY signal says an agent/human is actively working in it:

1. **Live processes rooted there**: `ps -axo pid,command | grep -Ei 'claude|agent|codex|gemini|agy|cld'`, then for hits `lsof -p <pid> 2>/dev/null | grep cwd` — cwd inside the worktree ⇒ ACTIVE.
2. **Recent file churn**: `find <wt> -newer <(recent 30-min marker) -not -path '*/node_modules/*' -not -path '*/.git/*'` — recent writes ⇒ likely ACTIVE.
3. **Git locks**: `index.lock` or in-progress merge/rebase state ⇒ treat as ACTIVE (someone is mid-operation).
4. **Orchestrator registries** if present (e.g. `stokd session list`, `stokd worktree` tooling, agent-link `list_agents`): a live session bound to the worktree ⇒ ACTIVE.

ACTIVE worktrees are listed in the report as excluded-with-reason and left completely untouched.

## Phase 3 — Landing order + plan gate

Order the remaining trees by **fork-point commit date, oldest first** (the tree that branched earliest lands first — it has waited longest and forces the fewest re-syncs). Break ties / adjust:
- If A and B overlap and B's diff builds on files A rewrote heavily, land the simpler/smaller one first.
- Independent (non-overlapping) trees keep pure fork-point order.

**Produce the Land Plan** — one line per worktree: order, branch, classification (LAND / LANDED-cleanup-only / SUPERSEDED / ACTIVE-excluded / NEEDS-HUMAN), commits ahead, files touched, overlaps, uncommitted-file count, and what "dev-complete" requires for it (build/tests/lint per repo convention).

**Gate**: this is the last read-only moment. If the session is interactive, show the plan and get a go-ahead (worktree removal is destructive). If running autonomously or the user already said to land everything, log the plan and proceed. If the user asked only for a report/dry-run, STOP HERE and deliver the plan.

## Phase 4 — Checkpoint everything (first mutation)

For every tree classified LAND, before anything else:

1. Commit ALL uncommitted work in place: `git -C <wt> add -A && git -C <wt> commit -m "wip(land-worktrees): checkpoint uncommitted work before landing"`. Untracked files count — `add -A`, not `add -u`. Skip only if clean.
2. Backup ref: `git update-ref refs/backup/land/<branch>/<UTC-timestamp> <branch>`. If the branch has never been pushed, also `git push origin <branch>` now so the work exists off-machine.
3. For SUPERSEDED trees: still checkpoint-commit and create the backup ref before anything is removed — "superseded" is a judgment that must stay reversible.

## Phase 5 — Parallel dev-complete

For each LAND tree that isn't already green, spawn one subagent per worktree (Agent tool, or a Workflow fan-out for many trees), all in parallel, **each with `model: "sonnet"`** and the escalation instructions from "Model routing & escalation" baked into its prompt. Each subagent, working ONLY inside its assigned worktree:

- Finish whatever is needed: make it compile, fix its tests, complete obviously-unfinished edits (a half-written function the diff clearly intends). Do not expand scope — the goal is *landable*, not *perfect*.
- Run the repo's verification (typecheck/build, lint, tests relevant to the diff). Report green/red with evidence.
- Commit results in the worktree. Never touch main, other worktrees, or shared state; never rebase.
- Return: branch, dev-complete yes/no, verification evidence — or a `HELP-NEEDED` request per the escalation loop instead of guessing.

When a worker returns HELP-NEEDED, the orchestrator investigates, answers via `SendMessage`, and the worker continues. Only after escalation stops producing progress is the tree reclassified NEEDS-HUMAN: leave it committed, pushed, and intact — do not land, do not remove.

## Phase 6 — Sequential landing loop

Land in Phase-3 order. **As soon as** the next-in-order tree is dev-complete, land it — don't wait for the whole fleet. (Trees later in the order keep cooking in parallel.)

For each tree, in its own worktree:

1. **Sync**: `git fetch origin`, then `git merge origin/<default>` (merge INTO the branch — never rebase, never switch branches). On conflicts, follow `references/conflict-resolution.md`: hand-merge every hunk so both sides' intent survives, then re-run verification.
2. **Verify**: repo's build/lint/tests green *after* the sync-merge. Red ⇒ fix or reclassify NEEDS-HUMAN.
3. **Push**: `git push -u origin <branch>` (pre-push hooks must pass — never `--no-verify`).
4. **PR + merge**: `gh pr create --base <default> --fill` (title/body summarizing the tree's actual changes), then merge following the repo's convention (`gh pr merge --squash --delete-branch` by default; use merge commits if that's what the repo history shows). If PRs are unavailable, fast-forward push to the default branch only if the repo has no protection requiring PRs.
5. **Confirm landed**: `git fetch origin` and verify `git diff origin/<default>...<branch>` is empty (content-level check, mandatory before any deletion).
6. **Cleanup**: `git worktree remove <wt>` (its dirty-check is a free safety net; investigate rather than `--force` if it refuses). If the folder lingers, `trash` it. Delete the local branch only with `-d` (not `-D`) or after step 5's content check passed. Keep the backup refs.
7. **Propagate**: update local default branch (`git -C <primary> pull --ff-only` if the primary is on it; otherwise just rely on `origin/<default>`). Trees still queued will absorb this on their own sync step.

Repeat until the queue is empty. One tree failing never aborts the loop — reclassify it and continue.

## Phase 7 — Final report

Deliver: landed (branch → PR link), cleaned-up worktrees, LANDED/SUPERSEDED trees handled, ACTIVE trees skipped (with the signal that excluded them), NEEDS-HUMAN trees (with exactly what's blocking), and the backup refs created. Explicitly confirm the no-loss invariant: every branch that existed at Phase 0 is now either reachable from main, still intact on disk, or preserved in `refs/backup/land/*` and on origin.

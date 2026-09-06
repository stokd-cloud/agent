# Triage — scoring, tiers, and escalators

The scorer (`scripts/conflict-triage.sh`) is deterministic and read-only. Same conflict state ⇒ same tier, every time. That reproducibility is the point: model spend must be defensible, not vibes.

## Why these inputs

Difficulty is **not** proportional to conflict size. A 400-line conflict where only one side moved is trivial; a 3-line conflict where both sides rewrote an auth check can lose a security fix. So the model scores four things:

### 1. Both-sides-changed (weight 3 — the dominant term)

Read from `zdiff3` markers, which expose the merge base:

```
<<<<<<< ours
ours text
||||||| base          ← only present with merge.conflictStyle=zdiff3
base text
=======
theirs text
>>>>>>> theirs
```

- `ours == base` → only *theirs* moved. False conflict from context drift. Nearly free.
- `theirs == base` → only *ours* moved. Same.
- both differ from base → **both sides changed the same logic.** This is where features get destroyed.

Without a base section (a `diff2`-style marker, or a merge produced before Phase 0 ran) the scorer counts the hunk as both-sides. Always over-estimate difficulty, never under-estimate.

### 2. Criticality (weight 2)

| score | class | paths |
|---|---|---|
| 3 | mission-critical | auth, billing, payment, secrets, credentials, tokens, crypto, security, permissions/permits, migrations, schema, `infrastructure/`, `deployment/`, `.github/workflows/`, IAM/policy, governance, `lander`, `land.rs`, `shove.rs` |
| 2 | core | ordinary source under `apps/`, `packages/`, `src/` |
| 1 | ordinary | tests, specs, `examples/`, `scripts/`, fixtures |
| 0 | docs | `*.md`, `*.mdx`, `*.rst`, `docs/`, `LICENSE` |

Criticality is about **blast radius of a silent mistake**. Docs are 0 not because docs don't matter but because a bad docs merge is cheap and visible. A bad auth merge is neither.

### 3. Structural class (penalty)

From git index stages (1=base, 2=ours, 3=theirs). Straight from CONGRA's finding that structure dominates difficulty:

| class | penalty | why |
|---|---|---|
| content | 0 | both sides edited an existing file — textual merge models this well |
| add/add | 1 | no common ancestor; two independent creations of the same path |
| rename | 2 | git's rename detection is a heuristic and can be wrong |
| modify/delete | 3 | one side deleted what the other developed — **intent clash, unmodellable textually** |
| binary | 3 | no textual merge exists |
| submodule | 3 | a wrong pointer silently rewinds an entire repo |

### 4. One-sided hunks (weight 1)

Counted, but cheap. They pad the score enough that a file with 40 false conflicts still gets a real model's attention, without pretending it's as hard as 5 genuine ones.

## Formula

```
file_score = criticality×2 + both_sides×3 + one_sided×1 + structural_penalty
score      = Σ file_score          (auto-resolvable files contribute 0)
```

## Tiers

| tier | threshold | workload slug | model tier | rationale |
|---|---|---|---|---|
| T0 | score 0 | — | none | fully mechanical |
| T1 | < 7 | `worker` | Economy | bounded, low blast radius |
| T2 | 7–24 | `codeReview` | mid | ordinary code judgment |
| T3 | ≥ 25 or any escalator | `escalation` | Strong | features at risk |

Slugs are the repo's canonical `TaskClass` values (`apps/cli/src/llm_routing.rs` → `models.workloads.*`). `escalation` is defined in-tree as "a Strong-tier agent a stuck Economy-tier unit of work escalates to" — exactly this use.

## Hard escalators → T3 unconditionally

Score is a proxy; these are known-dangerous regardless of how small they look.

- any non-auto file with criticality 3
- any modify/delete, binary, or submodule conflict
- ≥ 5 both-sides hunks in a single file
- more than 10 conflicted files

## Auto-resolvable (scored 0, handled with no model)

- **regenerate**: `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, `poetry.lock`, `go.sum`, `Gemfile.lock`, `composer.lock`, `dist/`, `build/`, `target/`, `*.generated.*`, `*.pb.go`, `*.snap`
- **union**: `CHANGELOG*`, `.gitignore`, `.dockerignore`, `AUTHORS`, `CODEOWNERS`

## Worked example

Real output from a five-class synthetic merge:

```
FILE                             CLASS          CR HUNK  BOTH  AUTO        SCORE
docs/guide.md                    content        0  1     1     -           3
packages/api/src/auth/login.ts   content        3  1     1     -           9
pnpm-lock.yaml                   content        2  1     1     regenerate  0
src/doomed.ts                    modify/delete  2  0     0     -           7
src/util.ts                      content        2  1     1     -           7

files=5  auto-resolvable=1  score=26  max-criticality=3
hard escalators:
  ! mission-critical path: packages/api/src/auth/login.ts
  ! modify/delete conflict: src/doomed.ts
TIER=T3  WORKLOAD=escalation
```

Note the lockfile scored 0 (regenerate, no model) while a *one-line* auth conflict alone forced T3. That asymmetry is the intended behavior.

## Tuning

Adjust the `criticality()` case globs for repos with different danger zones. Two rules when tuning:

1. **Never lower a criticality to make a landing cheaper.** Raise thresholds instead if cost is the problem.
2. **Re-run the worked example above after any change** — if the auth line stops forcing T3, the change is wrong.

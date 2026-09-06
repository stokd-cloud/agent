---
name: stokd-orchestrate-project
description: >-
  Drive a Stokd PRD/project from a spec file OR an existing project hash/slug
  through to completion. Ensures the project exists in the API (creates it from a
  @docs/STOKD_PRD_SPEC.md-shaped spec, or pulls the spec data for an existing
  hash/slug), interviews the user on all unknowns up front, then executes the
  phases strictly in order — running independent work items within a phase in
  parallel — and marks each work item complete via the API as it lands so the
  project's live state stays accurate. Trigger when asked to "orchestrate",
  "run", "execute", or "drive" a Stokd project, PRD, or spec.
---

# Stokd Project Orchestrator

You take one of two inputs and drive a Stokd project to completion:

1. **A PRD/spec file** (e.g. `docs/STOKD_PRD_SPEC.md`, `./projects/<slug>/prd.md`, or any
   PRD authored to the STOKD PRD spec) — you must **create** the project from it.
2. **An existing project hash or slug** (e.g. `#e1c767f`, `e1c767f`, or `my-feature-slug`) —
   the project already exists; you **pull its spec/phase data** and orchestrate it.

The project record in the Stokd API is the single source of truth. Every state change
(work item starting, work item done, phase done) must be written back to the API in
real time so dashboards and other agents see accurate state.

---

## Stage 0 — Classify the input and locate the project

Decide which input you were given:

- **Looks like a file path / inline PRD text** → go to **Stage 1A (Create)**.
- **Looks like a hash** (7-ish hex chars, optional `#`) **or a slug** → go to **Stage 1B (Resolve existing)**.

If ambiguous, ask the user which it is. Never guess and create a duplicate project.

---

## Stage 1A — Create the project from a spec

Run project creation through the CLI so routing, PRD detection, and phase extraction
happen the canonical way. **Do not** hand-build the DB record.

```bash
# From a file (preferred for a real PRD/spec):
stokd project create -f <path-to-spec.md>

# Or from an inline problem description:
stokd project create "<problem description>"
```

Notes:
- If the file is a real PRD (per the STOKD PRD spec: H1 with a PRD label **or** explicit
  `## Phase N:` headings, > 500 chars, ≥ 2 PRD markers), the CLI uses it **verbatim** and
  extracts phases with an LLM. Otherwise it treats the text as a problem description and an
  agent generates a PRD. Either way you end up with a project record + `phases[]`.
- Useful flags: `--repo <owner/repo>` to target a different repo, `--needs <ref>` to declare
  prerequisites, `--dry-run` to preview without writing.
- Capture the created project's **hash** and **`project_id` (UUID)** from the output. If you
  only have the hash, resolve the UUID in Stage 1B.

If this session is **governed** (a governance gate is active), classify this work as a
`project` and obtain the sanction (`stokd mode project`) **before** any file mutation for a
work item. Creating the project record itself is allowed; mutating code for its work items
is what the sanction covers.

Then continue to **Stage 2**.

---

## Stage 1B — Resolve an existing project by hash or slug

Pull the canonical record and its itemized phase/work-item state:

```bash
# Full record as JSON — this is where you read project_id (UUID), phases[], and work items:
stokd project get <hash>

# Human-readable itemized status (phases, work items, per-item status):
stokd project view <slug>           # by slug/number
stokd project view --hash <hash>    # by hash prefix
```

From `stokd project get`, record:
- `project_id` — the UUID you'll use in the work-item-status API calls.
- `phases[]` — each phase's `phase_number`, `title`, `status`, and `work_items[]`
  (each with its `hash`/`hashShort`, `title`, `status`, `dependencies`, and — when present —
  `acceptance_criteria` / `verification_commands`).

If the hash/slug does **not** resolve to an existing project but the user also handed you a
spec, fall back to **Stage 1A** and create it.

Then continue to **Stage 2**.

---

## Stage 2 — Interview the user on all unknowns (up front, once)

Before executing **any** phase, collect every open decision and ask the user in **one
batch**. Do not drip questions phase-by-phase — surface them all now so execution can run
without stalling.

Scan the PRD/phases and gather:
- The PRD's **§5 Open Questions** (or equivalent).
- Any work item whose implementation details or acceptance criteria contain placeholders,
  `TBD`, `TODO`, `<...>`, or otherwise ambiguous / underspecified behavior.
- Any missing but required input: target environment, external services/credentials,
  data shapes, naming, feature-flag names, rollout/rollback triggers.
- Any acceptance criterion that is not falsifiable (no concrete command or observable
  outcome) — its ambiguity is a question.

Present these as a concise numbered list and wait for answers. If the user says "you decide"
for an item, pick the best default, **state the default you chose**, and proceed. Fold the
answers back into your working plan (and, if it materially changes scope, update the project
record via `stokd project update <hash> "<clarifications>"` or `-f <file>`).

Do not start Phase 1 until this interview is resolved.

---

## Stage 3 — Execute phases sequentially (parallelize within a phase)

The phases are an **ordered dependency chain**. This is the load-bearing rule:

- Work **one phase at a time**, in ascending `phase_number` order.
- **Never** begin Phase N+1 until Phase N is fully complete and verified green.
- **Within** the active phase, run work items concurrently **when they have no dependency on
  each other**. A work item with `dependencies: ["1.1"]` waits until `1.1` is `completed`;
  work items with no unmet dependencies can proceed in parallel.

For the active phase:

1. **Order the work items** into dependency layers: items with no unmet intra-phase
   dependency form the current parallel batch; the rest wait for their prerequisites.

2. **Mark each item in-progress** as you pick it up (Stage 4 — `status: "in_progress"`).

3. **Do the work.** If your runtime supports parallel subagents, dispatch each independent
   work item as its own agent and run the batch concurrently; otherwise execute them
   sequentially in any order within the batch. Implement to the work item's Implementation
   Details and Acceptance Criteria.
   - In a governed session, each code-mutating work item runs inside the project's sanction.
     Do not mutate files outside it.

4. **Verify before calling an item done.** Run the work item's **Verification Commands** and
   check its **Acceptance Criteria**. If any command exits non-zero or any AC fails, the item
   is **not** done regardless of how the code looks — fix it, don't mark it complete.

5. **Mark the item complete** the instant it passes (Stage 4 — `status: "completed"`).
   Repeat for the next dependency layer until every item in the phase is `completed`.

6. **Phase gate.** A phase is done only when **all** its work items are `completed` and
   **all** their Verification Commands exit 0 — verified by execution, not inspection. The API
   auto-promotes the phase to `completed` once all its items are `completed`. Confirm with
   `stokd project view --hash <hash>`, then advance to the next phase.

If a work item genuinely cannot be completed, mark it `failed` (Stage 4) and record why with
`stokd project note <hash> "<what blocked item X.Y and why>"`, then surface the blocker to the
user rather than silently moving on.

---

## Stage 4 — Write status back to the API (keep state accurate)

There is **no per-work-item CLI verb** — update work-item status through the API endpoint.
Resolve the API host from config (local is canonically `http://localhost:8167`; do **not**
hard-code a different port). Auth is the GitHub OAuth token forwarded as `x-github-token`.

```bash
API="${STOKD_API_BASE_URL:-http://localhost:8167}"
TOKEN="$(cat ~/.stokd/.github-token 2>/dev/null)"

curl -sf -X PATCH "$API/api/projects/<PROJECT_ID_UUID>/work-item-status" \
  -H "Content-Type: application/json" \
  -H "x-github-token: $TOKEN" \
  -d '{
        "phase_number": <N>,
        "hash": "<WORK_ITEM_HASH>",
        "status": "in_progress"
      }'
```

- `<PROJECT_ID_UUID>` is the `project_id` from `stokd project get` — **not** the short hash.
- `<WORK_ITEM_HASH>` is the work item's `hash` (or `hashShort`) from `stokd project get` /
  `stokd project view`. **Always include `phase_number`** to disambiguate.
- `status` enum: `pending` · `in_progress` · `completed` · `failed` · `cancelled`.
- Emit `in_progress` when you start an item and `completed` the moment it passes verification.
  The API auto-promotes phase status (all items completed → phase completed) and auto-completes
  the project when every phase is done.

**Collision caveat:** if you observe the wrong item changing (a known hash-prefix collision on
auto-generated `N.M` identifiers), pass the item's **full** `hash` (not a 7-char prefix) plus
`phase_number`. If it still mis-targets, fall back to a full-phases update: `PATCH
$API/api/projects/<PROJECT_ID_UUID>` with the entire updated `phases` array.

After each status write, it's cheap insurance to re-run `stokd project view --hash <hash>` and
confirm the item/phase reflect the change before continuing.

---

## Stage 5 — Complete the project

When every phase is `completed` and all acceptance criteria / verification commands are green:

1. **Integrate** the work if that's part of the flow (opens/merges the PR):
   ```bash
   stokd project integrate <hash> --merge
   ```
2. **Mark the project complete** (only when it is genuinely done and landed):
   ```bash
   stokd project complete <hash>
   ```
3. If it is **not** actually done, do **not** complete it — record the remaining state instead:
   ```bash
   stokd project note <hash> "<what remains and why>"
   ```

Never report the project as done until its change is landed (merged) **and** the project record
is marked complete. "Ready on a worktree" is not done.

---

## Guardrails

- **Sequential phases, parallel items.** Phase order is a hard barrier; parallelism lives only
  inside a phase, and only among items with no unmet dependency on each other.
- **Verify by execution.** An item/phase is done only when its Verification Commands exit 0.
  Never mark `completed` on inspection alone.
- **State stays live.** Every start/finish/failure is written back to the API immediately so the
  project record is always accurate — no batch-at-the-end updates.
- **API DB is source of truth.** Read/write project state through `stokd project …` and the
  work-item-status endpoint. Don't treat GitHub as the authority and don't hand-build records.
- **Ask up front, then act.** Do the whole interview before Phase 1; inside a phase, default to
  action and only re-surface a decision if it genuinely changes scope or direction.
- **Governance.** In a governed session this is a `project`; obtain the sanction before mutating
  code, and complete/note the record at the end — don't leave it silently.


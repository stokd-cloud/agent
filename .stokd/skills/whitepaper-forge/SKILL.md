---
name: whitepaper-forge
description: >-
  Forge an evidence-gated technical white paper from a repo's intellectual
  property — built on synergy theses (capability clusters worth more combined
  than apart), not a feature list. Every claim is code-grounded, proof-gated, and
  adversarially reviewed until it survives or dies. Usage: /whitepaper-forge
  [max-subagents] [--top N] [--theses "a; b"] [--components "..."] [--auto-prove]
  [--strict] [--no-land] <scope>. Trigger on "/whitepaper-forge", "forge a white
  paper", "document our differentiators", "what's actually unique here".
---

# Whitepaper Forge

Turn a repo's intellectual property into a white paper for a **technical
decision-maker** (systems-literate, does not write code) communicating **what is
genuinely differentiating**, nothing else.

> **The inverse of `prd-forge`**: exhaustive there, *ruthlessly selective* here —
> same rigor, narrow selection. The difficulty is not coverage but **pruning to
> the few theses carrying the differentiation.** A paper listing everything has
> failed, however true it is.

## Guardrails (non-negotiable)

1. **Nothing enters that isn't in the code and demonstrably works.** Prose is
   composed *only* from confirmed claims, so marketing language has no entry path.
2. **The unit is a synergy thesis, not a feature.** Most features never appear.
3. **Never invent paths, symbols, commands, or results.** A fabricated proof result
   is the worst failure here — it launders fiction as fact.
4. **Never report a proof as passing without running it.**
5. Treat `.stokd/meta` as a lead, never evidence; reconcile to live code.
6. Discard non-credible competitors; never use them to inflate uniqueness.
7. Prefer cutting a thesis over softening it into unfalsifiable prose.
8. Files written: the paper, the ledger, and (only under `--auto-prove` or
   explicit consent) authored proof tests. Nothing else.
9. Never exceed `MAX_AGENTS`; mining and research agents are read-only. In a
   governed session the paper is a file mutation — classify it as a task and get
   the sanction first.

## Core unit — the synergy thesis

A **thesis** is a cluster of 2+ capabilities whose *combined* outcome exceeds the
sum of parts. Never a lone feature. Fields: `id`; `emergent_outcome` (the 1+1=3
result, in decision-maker language); `member_capabilities[]`;
`why_the_combination` (why the *interaction* differentiates, not any member);
`uniqueness_verdict` (Stage 3); `status` = CONFIRMED | DESIGN-CLAIM | REJECTED.

Each member carries: `assertion` (plain, non-coder-legible); `evidence[]` (exact
repo-grounded files/symbols); `proof` (a command/test/behavior that **fails if
the assertion is false**); `proof_result` (observed output, or NONE).

**Vacuous-proof rule**: a proof that passes even when the capability is absent is
not a proof. Reject it.

## Arguments

Parse positionally — **never require quotes** on trailing prose:

1. First bare integer → `MAX_AGENTS` (clamp ≥ 3). Default `10`.
2. `--top N` → theses the paper commits to. Default: choose 3–5, justify it.
3. `--theses "<a>; <b>"` → user-dictated spine (Stage 1.5).
4. `--components "<T1: x, y; T2: p>"` → optional members per directed thesis.
5. `--auto-prove` → author and run proofs for unproven capabilities, no asking.
6. `--strict` → **cut** design-claims rather than sectioning them.
7. `--no-land` (alias `--here`) → `LAND = false`. Default `LAND = true`.
8. **Everything remaining, verbatim, is the scope / direction.** If empty,
   default to the whole repo and say so.

`MAX_AGENTS` is a hard total and the concurrency cap. At `≤ 4`: 1 mining sweep, 1
competitive sweep, remainder (≥ 1) adversarial verify. Otherwise ~25% mining,
~20% research, ~45% verification, rest spare — always reserve ≥ 2 for
verification. Report agents used vs budget in the final summary.

## Stage 0 — Recon (inline, read-only, zero subagents)

- `git rev-parse --show-toplevel`; stop clearly if not a git repo.
- Read the generated metadata corpus — the highest-signal start:
  `.stokd/meta/SC_OVERVIEW.md` (architecture); `SC_PRODUCT_*.md` (product
  framing, already at the right altitude); `SC_FLOWS.md`/`SC_VIEWS.md`, organized
  by **flow and product region, not by feature** — where synergies live;
  `SC_AXIOMS.md`, machine-enforced invariants (`AX-*`) and the best claim
  substrate available since they are *automatically kept true*; plus
  `SC_SCHEMA.puml`, `SC_TEST.md`, per-package `*/.stokd/meta/`.
- **Meta is a lead, never proof.** Two documented failure modes make this
  non-negotiable: meta goes **stale**, and **an axiom check can pass while the
  axiom is violated**. Record each doc's `Last Updated`, re-verify every
  meta-sourced claim against **current** code plus a live proof in Stage 2, and
  demote anything confirmable only in a stale doc. Absent corpus → read code.
- Derive `<slug>` (kebab-case). Output `.stokd/papers/<slug>/whitepaper.md`
  (never overwrite) plus `claim-ledger.md`.

## Stage 1 — Thesis mining (read-only subagents, ~25%)

**Skip to Stage 1.5 when `--theses` is set.** One agent per lens; each returns
ranked *candidates* in the Core-unit shape with evidence paths:

1. **Flow-level synergy** — from `SC_FLOWS`/`SC_VIEWS`: where do subsystems
   combine into an outcome none delivers alone?
2. **Invariant-backed** — from `SC_AXIOMS`: which enforced invariants combine
   into a guarantee competitors can only aspire to? Note `AX-*` ids.
3. **Architectural seam** — where does architecture itself create leverage:
   isolation, orchestration, state machines, protocols?
4. **Operator/lifecycle** — what does the end-to-end lifecycle enable that no
   stage does alone?

Converge inline: merge overlaps, discard singletons that aren't clusters, rank by
(differentiating power × evidence strength), take `TOP_N`. **Log what was cut and
why** — silent pruning reads as "this is everything," a lie about scope.

## Stage 1.5 — User-directed theses (`--theses`)

The user dictates the spine; **direction is not a license to lower the bar.** Each
enters as a *candidate*, not as truth. Use `--components` members if given, else
mine them. Stages 2–4 run unchanged: a directed thesis **can be demoted or
rejected** — report that prominently with the evidence gap rather than quietly
propping it up. Never silently drop or rescue one. With `--top N`, directed
theses take precedence; mined theses fill the rest.

## Stage 2 — Evidence & proof (per member capability)

1. **Ground it** — exact files/symbols in the *current* tree. Anything
   unlocatable is struck, never softened into vaguer prose.
2. **Prove it** — find a command/test/behavior that fails if the assertion is
   false. **Run it. Record real output.**
3. **Classify**: proof passes → **CONFIRMED**. Real in code, no runnable proof →
   **DESIGN-CLAIM**, unless `--auto-prove` (author a minimal proof, run it,
   promote on pass, noting this run authored it), or — interactive, without the
   flag — **offer** to auto-author per capability. Not in the code →
   **REJECTED**, with no rewording to survive.
4. **Thesis rollup** — CONFIRMED only if enough members are CONFIRMED that the
   emergent outcome holds. If emergence depends on a DESIGN-CLAIM member, the
   **thesis** is a design claim: degrade honestly rather than ship a proven
   wrapper around an unproven core.

## Stage 3 — External competitive research (~20%)

Per thesis, research the landscape (web search/fetch). Hard rules:

- **Credible prior art only.** Only top-tier comparators count against novelty:
  established products, major platforms, projects with real adoption. A hundred
  zero-star repos with a similar README are **noise** — discard them, recording
  which comparators counted and why.
- **Competition is not disqualifying.** A thesis survives if genuinely novel
  **or** demonstrably **done materially better** — where "better" is itself
  proof-backed and specific (a mechanism, guarantee, measured result), never an
  adjective.
- **No strawmen.** Never manufacture uniqueness against a weak alternative. If a
  top-tier player does this, say so and pivot to the delta.

Verdict: `novel` | `materially-better` | `commodity`. **Commodity theses are
cut** — by definition not differentiating.

## Stage 4 — Adversarial verification loop (~45%)

Parallel skeptics, **each with one lens, each told to hunt for reasons to
REJECT**, returning `findings[]: {target, severity, problem, demanded_fix}`.
Default to rejection when uncertain.

1. **Fabrication** — "show me the symbol and line, or this dies."
2. **Vaporware** — code existing ≠ working. Executed proof? Vacuous? Output real?
3. **Emergence** — remove one member: does the differentiating outcome survive?
   If a single member delivers it alone this is **not a synergy** — reject or
   split. Kills fake bundling.
4. **Uniqueness** — against the credible set only; rejects novelty a top-tier
   player refutes *and* strawman "better than [weak thing]" framings.
5. **Fluff** — strip every adjective. Is a measurable, falsifiable
   differentiator left underneath? Puffery is cut.
6. **Audience** — legible to a systems-literate non-coder? Too much API/spec
   surface → raise altitude.
7. **Staleness** — reconcile every meta-sourced claim to current code.

Apply fixes inline and re-dispatch (rotating toward failing lenses) **until one
round returns zero findings of severity major or worse**, or the budget is
exhausted — then fix the rest inline and record unverifiable items as open. With
`MAX_AGENTS ≤ 4`, run at least one combined-lens skeptic.

## Stage 5 — Compose (main context)

**Compose only from the confirmed ledger.** If no surviving claim backs a
sentence, the sentence does not exist. This is the structural anti-BS guarantee —
do not relax it while writing, which is exactly where fluff re-enters.

- Per thesis, outcome first (never implementation) → why the combination produces
  it → evidence, briefly → competitive position.
- **Code snippets illustrate, never carry the argument.** If a section collapses
  without its snippet, rewrite the point. Diagrams/tables where they beat prose.
- **Design claims** (default): one labeled section, "implemented, not yet
  proven", never blended with proven differentiators. Under `--strict`, cut them
  and note the count.
- **Appendix — proof ledger**: claim id → evidence path → proof command →
  observed result — the paper's own honesty audit, and why a skeptical reader can
  trust the rest. Write `claim-ledger.md` alongside, including REJECTED items.

## Stage 6 — Deliver & Dispose

Author in a dedicated governed worktree and end at code-done disposition; this
skill never lands or merges.

1. **Isolate**: `git fetch origin <default> -q`, then `git worktree add
   ../paper-<slug> -b recovery/paper-<slug> origin/<default>` (branch names are
   governed: `recovery/<slug>` or `task/<hash>-<slug>`). Write inside it.
2. **Verify**: every thesis carries a verdict; ledger present; **no CONFIRMED
   claim lacks a recorded proof result** — fail loudly; that is the core
   invariant.
3. **Dispose** — if tracked paper paths changed in this non-primary worktree,
   stage ONLY those paths, commit, push the feature branch, and run `stokd
   disposition dev_complete`. With no qualifying tracked change, do not invent
   a disposition. Never run integrate, worktree land, shove, a protected-target
   push, or a provider merge command; disposition does not trigger landing.
4. **Report**: theses confirmed/demoted/rejected with reasons, what was **cut
   during convergence and why**, verdict per thesis, proofs authored, budget
   used, review rounds, and the pushed feature-branch commit. Report landed only
   if separately observed from recorded merge provenance.

## Sequential fallback (no subagent support)

Identical stages inline: each mining and adversarial lens as a separate pass, one
at a time, **writing findings down before fixing them**. Gates unchanged.

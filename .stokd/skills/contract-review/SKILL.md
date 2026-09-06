---
name: contract-review
description: >-
  Adversarially review a directory of Stokd VAL or EXP contract assertions.
  Use only for /contract-review, $contract-review, or an explicit request to
  invoke the contract review skill.
---

# Contract Review

Delegate the review cycle to `stokd contract review`.

1. Resolve one contract directory. Prefer the active project's contract
   directory only when it is unambiguous; otherwise ask for the path.
2. Preserve explicit `--passes` or `--reviewer` arguments.
3. Run `stokd contract review <contract-directory>` exactly once with those
   arguments.
4. Relay each pass result, remaining findings, output artifacts, and exit
   status. Do not weaken assertions or apply a passing verdict manually.

The CLI owns minimum pass count, reviewer dispatch, typed verdict parsing,
revision gating, persistence, and failure behavior. Missing evidence or an
unresolved major finding remains a failure.

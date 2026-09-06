# Playbook — mechanical recipes and per-tier protocols

## Part 1 — Mechanical recipes (Phase 3, no model)

Apply every recipe that matches before invoking any model. Re-run the triage script afterward; the post-mechanical score is what you route on.

### rerere hits

With `rerere.enabled`, git replays resolutions you have already made. On a branch being repeatedly re-synced this is the biggest single win.

```bash
git rerere status          # paths still unresolved
git rerere diff            # what rerere applied — REVIEW IT
```

Rerere is a *textual* replay. Review its output like any other resolution and run it through Phase 5 gates. Do not trust it blindly on mission-critical paths.

### One-sided hunks (false conflicts)

The most common conflict on a stale branch, and it needs no judgment at all. With `zdiff3`, if `ours == base`, only theirs moved — take theirs; if `theirs == base`, take ours. Verify per-hunk, not per-file: one file often contains both.

Cross-check a whole file cheaply:

```bash
B=$(git merge-base HEAD MERGE_HEAD)
git diff --quiet $B:path HEAD:path       && echo "ours unchanged → take theirs"
git diff --quiet $B:path MERGE_HEAD:path && echo "theirs unchanged → take ours"
```

### Lockfiles and generated artifacts — regenerate, never merge

A hand-merged lockfile is an invalid lockfile: the integrity hashes and the resolution graph no longer correspond to the manifests. Take either side to clear the conflict, then regenerate from the *merged* manifests:

```bash
git checkout --theirs pnpm-lock.yaml && git add pnpm-lock.yaml
# resolve package.json properly FIRST (it is a real conflict), then:
pnpm install --lockfile-only        # cargo generate-lockfile / go mod tidy / etc.
git add pnpm-lock.yaml
```

Same for `dist/`, `target/`, snapshots, protobuf/codegen output: resolve the *source*, re-run the generator, stage the result. If the generator can't run, that's an escalation, not a reason to hand-edit.

### Union-mergeable files

Append-only accumulations where the only real failure is a lost entry. Keep both sides, dedupe, preserve chronology (newest-first for changelogs).

**Preferred — the built-in `union` driver.** `union` ships with git; do *not* define `merge.union.driver` yourself, that overrides the working built-in with a worse one. Declaring it in `.gitattributes` prevents the conflict from ever occurring:

```bash
printf 'CHANGELOG.md merge=union\n.gitignore merge=union\nCODEOWNERS merge=union\n' >> .gitattributes
```

Verified: with this attribute the same CHANGELOG divergence merges cleanly, both entries intact, zero conflicts.

**One-off, for an already-conflicted file** — extract the three stages to **real files first**:

```bash
T=$(mktemp -d)
git show :1:CHANGELOG.md > "$T/base"    # 1 = merge base
git show :2:CHANGELOG.md > "$T/ours"    # 2 = ours
git show :3:CHANGELOG.md > "$T/theirs"  # 3 = theirs
git merge-file -p --union "$T/ours" "$T/base" "$T/theirs" > CHANGELOG.md
git add CHANGELOG.md
```

> **Do not use process substitution here.** `git merge-file -p --union <(git show :2:...) <(...) <(...)` looks equivalent and runs without error, but the `/dev/fd` pipes are not seekable and git silently emits only one side — **losing the other side's entries with a zero exit code.** This was caught in testing; it is precisely the class of silent loss this skill exists to prevent. Always materialize the stages to real files and confirm both sides appear in the output.

### Import / use blocks

Union both sides, dedupe, re-sort with the repo's formatter (ESLint `--fix`, `rustfmt`, `goimports`). Never drop an import you don't recognize — it belongs to the other side's feature and dropping it breaks their code, loudly or otherwise.

### Formatting-only divergence

If the two sides differ only in whitespace/formatting, take either and run the formatter:

```bash
git diff -w --stat        # empty ⇒ whitespace-only
```

## Part 2 — Per-tier resolution protocols

Every tier ends at the same Phase 5 gates. What changes is context depth and how much is read before deciding.

### T1 — `worker` (Economy): docs, prose, comments

Scope: prose only, no semantic interlock.

1. Read both sides fully.
2. Merge intent: if both added content, keep both, ordered sensibly. If both edited the same sentence, compose one that carries both facts.
3. Never delete a claim, warning, or example that exists on only one side.
4. Gates: no markers; docs build/lint if the repo has one.

Escalate to T2 if the "docs" turn out to carry executable content — embedded code samples that are tested, schema fragments, or config blocks.

### T2 — `codeReview` (mid): ordinary code

Scope: core/ordinary source, bounded hunk counts, no escalators.

1. For each conflicted file, read the **full file**, not just the hunk. A hunk without its surrounding function is unresolvable.
2. Establish each side's intent from its commits:
   ```bash
   B=$(git merge-base HEAD MERGE_HEAD)
   git log --oneline $B..HEAD       -- <file>   # what ours was doing
   git log --oneline $B..MERGE_HEAD -- <file>   # what theirs was doing
   ```
3. Compose a result that satisfies **both** intents. Choosing a side is legitimate only when one side's change is a strict superset of the other's — and you must be able to say why.
4. Check callers of anything whose signature changed on either side; a signature merged from two sides breaks callers from both.
5. Gates: markers, typecheck, both-sides survival, relevant tests.

Escalate to T3 the moment you find: a semantic interaction you can't fully trace, a signature change with callers you can't enumerate, or a hunk touching anything on the criticality-3 list.

### T3 — `escalation` (Strong): mission-critical, heavily diverged, structural

Scope: everything the escalators catch, plus anything T2 handed up.

1. **Reconstruct both narratives before touching anything.** Read the full commit series on each side of the merge base for every conflicted file, plus the PR/task description if present. Write down, per file, one sentence for what each side was trying to accomplish.
2. **Map the semantic surface**: for every symbol in a conflicted hunk, find its callers, implementors, and tests on *both* sides. Two individually-correct changes can merge into something broken — this is the failure mode textual merging cannot see, and it is the whole reason this tier exists.
3. **Resolve hunk by hunk**, never file-wholesale, never `--ours`/`--theirs` on a real code conflict.
4. **Structural conflicts get explicit reasoning, not defaults:**
   - *modify/delete*: determine why it was deleted. Deleted as dead code while the other side actively developed it ⇒ **keep the modified version** and flag it — deletion was based on stale information. Deleted because it was genuinely superseded/migrated ⇒ port the other side's change onto the successor. Never resolve by accepting the delete just because that clears the conflict fastest.
   - *rename*: verify git's detection (`git log --follow -M`). Apply the other side's edits to the renamed path, and update every reference to the old path from both sides.
   - *submodule*: never guess. Read both pointers' logs; take the one that is a descendant of the other. If neither is, the submodule itself needs a merge first — that's a separate landing.
   - *binary*: pick by provenance, never by content. Which side authored it most recently, for what purpose? If unclear, escalate to human.
   - *add/add*: two independent implementations of the same path. Usually both features are wanted — merge them, or keep both under distinct names and reconcile call sites.
5. **Gates, all four, strictly.** Plus: re-read the final file end to end and confirm it is coherent code someone intended to write — not two half-merges stitched together.

Escalate to human only after this protocol genuinely cannot decide. Then follow the terminus rules in `SKILL.md`: preserve everything, report which hunk, both intents, and the missing decision.

## Part 3 — Recovery

Everything here is reversible; nothing justifies a destructive shortcut.

```bash
git merge --abort                  # clean bail from a conflicted merge
git rerere forget <path>           # drop a bad recorded resolution
git checkout -m <path>             # restore conflict markers after a botched edit
git reflog                         # find any pre-merge state
git show refs/backup/conflict/...  # the Phase 0 snapshot
```

If a resolution was committed and later found to have dropped work, recover the lost side from the backup ref and re-apply it as a follow-up commit. Do **not** rewrite the landed history to hide it.

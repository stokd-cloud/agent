#!/usr/bin/env bash
# conflict-triage.sh — deterministic conflict difficulty scorer.
#
# Reads the CURRENT conflicted merge state of a repo and emits a triage report:
# per-file structural class, criticality, hunk counts, both-sides-changed counts,
# a numeric difficulty score, and the model workload tier that should resolve it.
#
# This script NEVER mutates the repo. It is pure measurement. Resolution is a
# separate, later step — see ../SKILL.md.
#
# Usage:
#   conflict-triage.sh [--repo <dir>] [--json] [--verbose]
#
# Exit codes:
#   0  triage produced (read $TIER in output)
#   3  no conflicts present (nothing to triage)
#   4  not a git repo / no merge in progress and no unmerged paths

set -uo pipefail

REPO="."
FORMAT="text"
VERBOSE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --json) FORMAT="json"; shift ;;
    --verbose) VERBOSE=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac
done

cd "$REPO" 2>/dev/null || { echo "cannot cd to $REPO" >&2; exit 4; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repo: $REPO" >&2; exit 4; }

# ── Enumerate unmerged paths ────────────────────────────────────────────────
# `git ls-files -u` stages: 1=base(common ancestor) 2=ours 3=theirs
# Portable across bash 3.2 (macOS system bash) — no mapfile/readarray.
UNMERGED=""
while IFS= read -r _p; do
  [ -n "$_p" ] && UNMERGED="${UNMERGED}${_p}
"
done < <(git diff --name-only --diff-filter=U 2>/dev/null | sort -u)

if [ -z "$UNMERGED" ]; then
  echo "no conflicts"
  exit 3
fi

# ── Classification tables ───────────────────────────────────────────────────

# Regenerable artifacts: NEVER hand-merge these. Take one side, then regenerate
# from the merged inputs. Hand-merging a lockfile produces an invalid lockfile.
is_regenerable() {
  case "$1" in
    *pnpm-lock.yaml|*package-lock.json|*yarn.lock|*Cargo.lock|*poetry.lock|*go.sum|*Gemfile.lock|*composer.lock) return 0 ;;
    */dist/*|*/build/*|*/node_modules/*|*/target/*|*/.turbo/*) return 0 ;;
    *.generated.*|*_generated.*|*.gen.go|*.pb.go|*_pb2.py|*.snap) return 0 ;;
    *)  return 1 ;;
  esac
}

# Append-only / union-mergeable: order-insensitive accumulations where losing an
# entry is the only real failure mode.
is_union_mergeable() {
  case "$1" in
    *CHANGELOG*|*/CHANGELOG.md|*.gitignore|*.dockerignore|*/AUTHORS|*/CODEOWNERS) return 0 ;;
    *)  return 1 ;;
  esac
}

# Criticality: 3=mission-critical 2=core 1=ordinary 0=docs
criticality() {
  local f="$1"
  case "$f" in
    # Mission-critical: silent breakage here costs money, data, or access.
    *auth*|*Auth*|*billing*|*Billing*|*payment*|*Payment*|*secret*|*Secret*|\
    *credential*|*token*|*crypto*|*security*|*permission*|*permit*|\
    *migration*|*migrations/*|*schema*|*Schema*|\
    infrastructure/*|deployment/*|.github/workflows/*|*/iam/*|*policy*|\
    *governance*|*lander*|*land.rs|*/shove.rs)
      echo 3; return ;;
    # Docs: prose. Wrong merge is cheap and visible.
    *.md|*.mdx|*.txt|*.rst|docs/*|*/docs/*|LICENSE*|*.adoc)
      echo 0; return ;;
    # Ordinary: tests, examples, local scripts.
    *test*|*Test*|*spec*|*.spec.*|*.test.*|examples/*|scripts/*|*/fixtures/*)
      echo 1; return ;;
    # Core: everything else that is real source.
    *) echo 2; return ;;
  esac
}

# Structural class from index stages. Penalty reflects how badly plain textual
# merging models the situation.
#   content       0  both sides edited the same lines of an existing file
#   add/add       1  no common ancestor — two independent creations
#   rename        2  path moved on one side; git's detection may be wrong
#   modify/delete 3  one side deleted what the other developed: intent clash
#   binary        3  no textual merge exists at all
#   submodule     3  pointer conflict; wrong pick silently rewinds a whole repo
structural_class() {
  local f="$1" stages base ours theirs
  stages=$(git ls-files -u -- "$f" 2>/dev/null | awk '{print $3}' | sort -u | tr '\n' ' ')
  base=0; ours=0; theirs=0
  case " $stages " in *" 1 "*) base=1 ;; esac
  case " $stages " in *" 2 "*) ours=1 ;; esac
  case " $stages " in *" 3 "*) theirs=1 ;; esac

  if [ "$(git ls-files -s -- "$f" 2>/dev/null | awk '{print $1}' | sort -u | head -1)" = "160000" ]; then
    echo "submodule 3"; return
  fi
  if [ "$base" -eq 0 ] && [ "$ours" -eq 1 ] && [ "$theirs" -eq 1 ]; then
    echo "add/add 1"; return
  fi
  if [ "$ours" -eq 0 ] || [ "$theirs" -eq 0 ]; then
    echo "modify/delete 3"; return
  fi
  # Binary if git refuses to diff it textually.
  if git diff --numstat --diff-filter=U -- "$f" 2>/dev/null | grep -q '^-	-	'; then
    echo "binary 3"; return
  fi
  # Rename detection: path present on one side only under a different name.
  if [ -n "$(git diff --name-status -M --diff-filter=R HEAD -- "$f" 2>/dev/null)" ]; then
    echo "rename 2"; return
  fi
  echo "content 0"
}

# Count conflict hunks and how many have real changes on BOTH sides.
#
# The both-sides signal is the single most important input: a hunk where only one
# side moved is a false conflict (context drift) and is near-free to resolve; a
# hunk where both sides rewrote the same logic is where features get silently
# destroyed. We read it from diff3-style markers, which expose the merge base:
#
#   <<<<<<< ours
#   ours text
#   ||||||| base
#   base text
#   =======
#   theirs text
#   >>>>>>> theirs
#
# ours != base AND theirs != base  ⇒ both sides changed ⇒ expensive.
hunk_counts() {
  local f="$1"
  [ -f "$f" ] || { echo "0 0"; return; }
  awk '
    BEGIN { hunks=0; both=0; sec=0 }
    /^<<<<<<</  { hunks++; sec=1; o=""; b=""; t=""; hasbase=0; next }
    /^\|\|\|\|\|\|\|/ { if (sec) { sec=2; hasbase=1 } ; next }
    /^=======$/ { if (sec) sec=3; next }
    /^>>>>>>>/  {
        if (sec) {
          # No base section (diff2 style): assume both sides changed — the
          # conservative reading. Never under-report difficulty.
          if (!hasbase)            both++
          else if (o != b && t != b) both++
        }
        sec=0; next
    }
    { if (sec==1) o=o $0 "\n"; else if (sec==2) b=b $0 "\n"; else if (sec==3) t=t $0 "\n" }
    END { print hunks, both }
  ' "$f"
}

# ── Score every conflicted file ─────────────────────────────────────────────
TOTAL=0
FILE_COUNT=0
MAX_CRIT=0
MAX_BOTH=0
HAS_HARD=0
HARD_REASONS=""
ROWS=""
JSON_FILES=""
AUTO_COUNT=0

while IFS= read -r f; do
  [ -n "$f" ] || continue
  FILE_COUNT=$((FILE_COUNT + 1))

  read -r sclass spen <<<"$(structural_class "$f")"
  crit=$(criticality "$f")
  read -r hunks both <<<"$(hunk_counts "$f")"

  auto="-"
  if is_regenerable "$f"; then auto="regenerate"; fi
  if is_union_mergeable "$f"; then auto="union"; fi
  if [ "$auto" != "-" ]; then AUTO_COUNT=$((AUTO_COUNT + 1)); fi

  # file_score = criticality*2 + both_sides*3 + one_sided + structural_penalty
  one_sided=$((hunks - both))
  [ "$one_sided" -lt 0 ] && one_sided=0
  fscore=$(( crit * 2 + both * 3 + one_sided + spen ))
  # Mechanically auto-resolvable files contribute no model difficulty.
  [ "$auto" != "-" ] && fscore=0

  TOTAL=$((TOTAL + fscore))
  [ "$crit" -gt "$MAX_CRIT" ] && MAX_CRIT=$crit
  [ "$both" -gt "$MAX_BOTH" ] && MAX_BOTH=$both

  # ── Hard escalators: these jump straight to the top tier regardless of score.
  if [ "$auto" = "-" ]; then
    if [ "$crit" -ge 3 ]; then
      HAS_HARD=1; HARD_REASONS="${HARD_REASONS}mission-critical path: $f
"
    fi
    case "$sclass" in
      modify/delete|submodule|binary)
        HAS_HARD=1; HARD_REASONS="${HARD_REASONS}$sclass conflict: $f
" ;;
    esac
    if [ "$both" -ge 5 ]; then
      HAS_HARD=1; HARD_REASONS="${HARD_REASONS}$both both-sides hunks in one file: $f
"
    fi
  fi

  ROWS="${ROWS}$(printf '%-52s %-14s %-2s %-5s %-5s %-11s %s' \
      "$f" "$sclass" "$crit" "$hunks" "$both" "$auto" "$fscore")
"
  JSON_FILES="${JSON_FILES}    {\"path\":\"$f\",\"class\":\"$sclass\",\"criticality\":$crit,\"hunks\":$hunks,\"both_sides\":$both,\"auto\":\"$auto\",\"score\":$fscore},
"
# Herestring (not a pipe) so the accumulators above survive the loop.
done <<< "$UNMERGED"

if [ "$FILE_COUNT" -gt 10 ]; then
  HAS_HARD=1; HARD_REASONS="${HARD_REASONS}$FILE_COUNT conflicted files (>10) — broad divergence
"
fi

# ── Tier selection ──────────────────────────────────────────────────────────
# T0 mechanical | T1 worker(economy) | T2 codeReview | T3 escalation(strong)
if [ "$TOTAL" -eq 0 ]; then
  TIER="T0"; WORKLOAD="none"; RATIONALE="every conflict is mechanically auto-resolvable"
elif [ "$HAS_HARD" -eq 1 ]; then
  TIER="T3"; WORKLOAD="escalation"; RATIONALE="hard escalator tripped"
elif [ "$TOTAL" -ge 25 ]; then
  TIER="T3"; WORKLOAD="escalation"; RATIONALE="score $TOTAL >= 25 (broad both-sides divergence)"
elif [ "$TOTAL" -ge 7 ]; then
  TIER="T2"; WORKLOAD="codeReview"; RATIONALE="score $TOTAL in 7..24 (ordinary code conflict)"
elif [ "$MAX_CRIT" -eq 0 ]; then
  TIER="T1"; WORKLOAD="worker"; RATIONALE="docs/prose only, score $TOTAL"
else
  TIER="T1"; WORKLOAD="worker"; RATIONALE="score $TOTAL < 7 (small, bounded)"
fi

# ── Emit ────────────────────────────────────────────────────────────────────
if [ "$FORMAT" = "json" ]; then
  printf '{\n  "files": [\n%s  ],\n' "$(printf '%s' "$JSON_FILES" | sed '$ s/,$//')"
  printf '  "file_count": %s,\n  "auto_resolvable": %s,\n  "score": %s,\n' \
      "$FILE_COUNT" "$AUTO_COUNT" "$TOTAL"
  printf '  "max_criticality": %s,\n  "max_both_sides": %s,\n' "$MAX_CRIT" "$MAX_BOTH"
  printf '  "hard_escalators": %s,\n' "$([ "$HAS_HARD" -eq 1 ] && echo true || echo false)"
  printf '  "tier": "%s",\n  "workload": "%s",\n  "rationale": "%s"\n}\n' \
      "$TIER" "$WORKLOAD" "$RATIONALE"
else
  echo "── conflict triage ─────────────────────────────────────────────────────────"
  printf '%-52s %-14s %-2s %-5s %-5s %-11s %s\n' FILE CLASS CR HUNK BOTH AUTO SCORE
  printf '%s' "$ROWS"
  echo "───────────────────────────────────────────────────────────────────────────"
  echo "files=$FILE_COUNT  auto-resolvable=$AUTO_COUNT  score=$TOTAL  max-criticality=$MAX_CRIT"
  if [ -n "$HARD_REASONS" ]; then
    echo "hard escalators:"
    printf '%s' "$HARD_REASONS" | sed 's/^/  ! /'
  fi
  echo "TIER=$TIER  WORKLOAD=$WORKLOAD"
  echo "reason: $RATIONALE"
fi

exit 0

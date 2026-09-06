---
name: session-group
description: >-
  Find productive sessions across configured Stokd providers for a repository,
  branch, or topic and open the top matches in batched cmux workspaces. Use for
  /session-group or requests to reopen or group prior agent sessions.
---

# Session Group

Use Stokd's machine-local session index as the only discovery and ranking
source. The bundled script handles time filtering, portable resume commands,
and 2x2 cmux layouts.

## Usage

```text
/session-group <target> [relativeTime] [topN]
```

- `target`: repository, owner/repository, branch, or exact search phrase.
- `relativeTime`: defaults to `48h`; accepts `s`, `m`, `h`, `d`, or `w`.
- `topN`: defaults to `4` and is batched into workspaces of at most four panes.

## Procedure

1. Resolve the script from the first existing path:
   - `$STOKD_SKILLS_DIR/session-group/scripts/session_group.py`
   - `~/.stokd/skills/session-group/scripts/session_group.py`
   - `apps/cli/templates/skills/session-group/scripts/session_group.py`
2. Run:
   `python3 <script> --target <target> --since <relativeTime> --top <topN>`.
   Add `--dry-run` only for a requested preview.
3. The script calls `stokd session find <target> --json`, preserving Stokd's
   configured-provider discovery, machine usage weighting, and indexed ranking.
4. Every pane resumes through `stokd chat -C <cwd> resume <session-id>`; the
   script never calls a provider binary directly.
5. Report the ranked sessions, provider, score, title, cwd, group reference,
   `workspace-group` reference, workspace references, and any failures.

## Rules

- Requires a live cmux-compatible socket only when not using `--dry-run`.
- If cmux is unavailable, print exact portable resume commands and stop.
- Never stash, reset, switch branches, fork sessions, or edit provider stores.
- Open at most the requested number of sessions and focus only the first new
  workspace unless `--no-focus` is supplied.
- Session indexing is local machine state. Do not claim cloud-wide or
  cross-machine completeness.

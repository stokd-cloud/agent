---
name: check-work
description: >-
  Independently verify completed work against the user's request, repository
  instructions, diff, tests, and real behavior surface. Use for /check-work,
  /check, /verify, /self-verify, or explicit requests to check recent work.
---

# Check Work

Return an evidence-backed `PASS` or `FAIL`. Verification checks outcomes, not
effort, task status, worker claims, or the existence of a diff.

## Procedure

1. Reconstruct the complete request, including corrections and follow-ups, as a
   binary checklist. If a current project contract exists, include every live
   assertion in scope.
2. Read repository instructions, inspect the actual checkout, and collect the
   complete relevant diff: unstaged, staged, and task commits relative to the
   sanctioned base.
3. Map every changed file and behavior to a checklist item. Flag requested work
   that was omitted and unrelated work that widened scope.
4. Run the repository's real build, lint, test, and validation commands. Record
   the exact command, exit status, and useful output. A green command is evidence
   only for behavior it actually covers.
5. Exercise the real caller/user/operator surface when the request affects one:
   browser, CLI, API, TUI, job, artifact, data, migration, or public library.
   Include meaningful negative controls, edge cases, and failure paths.
6. When an independent verification agent is available, give it the raw request,
   diff or artifact, relevant instructions, and validation commands—not the
   expected verdict or suspected bug. Keep it read-only. If none is available,
   perform a separate adversarial pass after clearing the implementation frame.
7. Compare all evidence with the checklist. Missing required evidence is a
   failure, not an invitation to weaken the requirement.
8. If the user also asked to fix failures, repair the root cause and repeat the
   complete relevant checks up to three bounded cycles. Otherwise stop after the
   diagnosis without mutating files.

## Output contract

Report:

- checklist item → verdict → evidence;
- diff and surface reviewed;
- commands and exit statuses;
- unverified areas and why;
- actionable issues with file/line or surface identifiers.

End with exactly `VERDICT: PASS` or `VERDICT: FAIL`.

Do not assume access to any provider-specific subagent type, session transcript,
or tool name. Use the independent read-only verification surface available in
the current runtime.

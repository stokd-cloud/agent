---
name: stokd-task-one-shot
description: >
  Use when work should be dispatched as a governed one-shot task rather than
  edited inline in a planning chat.
---

# Stokd Task One-Shot

## When to use
- User wants a complete task executed end-to-end
- Planning session is blocked from mutating files
- Work is larger than a single trivial edit

## Procedure
1. Capture a clear objective + acceptance criteria + validation commands.
2. Dispatch via `stokd task one-shot` using the sanctioned heredoc recipe from
   SC_CONTEXT / the governance stop message.
3. Do not manually sanction around the workflow.
4. Report the task id, outcome, and validation evidence.

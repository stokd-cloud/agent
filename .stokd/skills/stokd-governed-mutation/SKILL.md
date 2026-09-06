---
name: stokd-governed-mutation
description: >
  Use when the user asks for any file mutation, implementation, refactor, or
  code change in a Stokd-governed session. Enforces plan → approve → implement.
---

# Stokd Governed Mutation

## When to use
Any request that will create, edit, delete, or restructure files.

## Procedure
1. Restate the objective in one paragraph.
2. Write binary acceptance criteria and a runnable validation plan.
3. Declare Components/Modules you will touch.
4. Request approval with:
   ```
   stokd mode task <<EOF
   Objective: ...
   Acceptance Criteria:
   - ...
   Validation Plan:
   - ...
   Components/Modules:
   - ...
   Axiom Changes: None — bounded by [[ax-existing-slug]]
   EOF
   ```
5. Only after APPROVE, implement. Do not retry blocked writes.
6. Run validation commands and report outcomes.

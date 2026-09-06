---
name: integrate
description: >-
  Integrate completed Stokd task or project work into its main branch. Use only
  when the user explicitly invokes /integrate, $integrate, or asks to invoke
  the Stokd integration skill.
---

# Integrate

Require one task or project identifier, then run
`stokd integrate <identifier>` exactly once. Pass any explicit flags through
unchanged and relay the output and exit status.

The CLI owns reference resolution, completion checks, validation, serialized
landing, backup refs, merge behavior, and disposition updates. Do not run raw
Git landing commands, bypass validation, infer a different identifier, or
repeat the integration after an ambiguous failure.

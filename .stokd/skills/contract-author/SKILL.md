---
name: contract-author
description: >-
  Author falsifiable Stokd VAL contract assertions from a request or file. Use
  only for /contract-author, $contract-author, or an explicit request to invoke
  the contract authoring skill.
---

# Contract Author

Delegate authoritative contract generation to `stokd contract author`.

1. Preserve the request verbatim as inline text or a readable file path.
2. Use the active project's contract directory when one is unambiguous. When
   authoring a standalone contract, require or derive a clear output directory
   such as `.stokd/contracts/<slug>` and report it before execution.
3. Run exactly one command:
   `stokd contract author --out <directory> <TEXT|FILE>`.
4. Relay the created assertion files and exit status. Do not rewrite generated
   assertions unless the user separately requests an editing pass.

The CLI owns the authoring prompt, assertion grammar, untrusted-input handling,
provider selection, typed output parsing, and writes. Use `contract-review`
after authoring when adversarial review is required.

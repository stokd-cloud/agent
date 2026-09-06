---
name: governance
description: >
  Report THIS stokd session's governance (status), or flip it live
  (on/off/auto, biometric-gated). Use when the user types /governance,
  /governance status, /governance on, /governance off, or /governance auto.
  Affects ONLY the current session; a Touch ID / Windows Hello prompt gates
  on/off/auto (status needs no prompt).
---

# /governance — report or flip the current session's governance

Map the argument to ACTION: `status` (report only — the DEFAULT when no arg is
given), `on` (force governed), `off` (ungovern — allow mutations), `auto` (clear
override → launch default). Flips take effect on the next tool call, no relaunch.

## status — bare `/governance`, or `/governance status`
PURELY MECHANICAL. Do NOT spawn a subagent, do NOT reason about it, do NOT
lecture the user about launching a governed session, and NEVER conclude "not
governed" just because `$STOKD_SESSION_ID` is empty — an empty session id does
NOT mean ungoverned. Run exactly this one line and relay its output verbatim as
a single line, then STOP:
```
stokd governance session status "$STOKD_SESSION_ID" 2>/dev/null || { [ -n "$STOKD_GOVERNANCE_MODE" ] && echo "governed (mode: $STOKD_GOVERNANCE_MODE)" || echo "ungoverned"; }
```
The `status` verb is read-only, never biometric-gated, and resolves the live
session itself; the `||` fallback answers straight from the environment when no
live session record resolves (governed iff `STOKD_GOVERNANCE_MODE` is non-empty).

## on / off / auto — biometric-gated flip (these three only)
1. Show current state first with the status line above.
2. If the flip WOULD change the state, run (this raises a Touch ID / Windows
   Hello prompt — tell the user "touch the sensor to confirm"):
   ```
   stokd governance session <ACTION> "$STOKD_SESSION_ID" --biometric
   ```
   Then re-run the status line and report the new effective state. If it is
   already what the user asked for, say so and STOP — no redundant override.

## Rules
- ALWAYS pass `--biometric` for on/off/auto — the physical fingerprint is the only
  thing that writes the override; the in-session agent cannot complete it alone.
  Never bypass, retry around, or suppress the prompt.
- `status` needs no biometric and no session id — it is safe to run from anywhere.
- If the biometric is cancelled, or the flip is refused (e.g. a captured/one-shot
  session is refused with NO prompt), report the message verbatim and STOP — that
  refusal is correct behavior.
- Never edit governance/override files by hand or sign anything to work around a
  refusal or a missing prompt.
- If `stokd governance session` is unknown, the local stokd build predates the
  feature — say so instead of improvising.

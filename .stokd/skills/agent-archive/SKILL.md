---
name: agent-archive
description: >
  Archive the current interactive agent session by name so it can be revived
  later as one or more fresh independent copies. Use when the user runs
  /agent-archive <name>, or asks to "archive this session", "snapshot this
  agent", or "save this session as <name>".
---

# agent-archive

Archive the CURRENT interactive session under a user-chosen name via
`stokd archive create`. The archive captures the provider transcript
(claude or codex) plus a manifest with the cwd and git coordinates
(branch + HEAD), zenith-archive style — never the repo contents.

Revival is repeatable: `stokd archive revive <name>` materializes a fresh
session id every time, so the same archive can be revived many times in a
row and each copy is an independent resumable session.

## Usage

```
/agent-archive <archive-name>
```

## Instructions

1. Take the archive name from the user's argument. If none was given, ask
   for one. Valid names are alphanumeric plus `-`, `_`, `.`.

2. Plant a marker in this session's transcript, as its own SEPARATE command
   run FIRST (providers flush a tool call into the transcript only after it
   completes, so the marker command must fully finish before the create
   verb runs):

   ```bash
   echo "agent-archive-marker: agent-archive-$(uuidgen)"
   ```

   Then, as a SECOND command, run the create verb passing the exact marker
   value that was echoed:

   ```bash
   stokd archive create <archive-name> --marker "<the echoed agent-archive-... value>"
   ```

   Why the marker: by create time the completed echo (command + output) is
   persisted in this session's transcript, so the transcript containing the
   marker IS this session — even when other sessions share the same working
   directory. Without it, the newest transcript is used, which can misfire
   when sessions run concurrently. Do NOT combine the two steps into one
   command — an inline marker is not yet flushed when create greps for it.

3. Report the result to the user:
   - the archive location printed by the command
     (`~/.stokd/agent-archives/<archive-name>/`), and
   - how to revive it: `stokd archive revive <archive-name>` — repeatable;
     each revive launches an independent fresh copy of this session in the
     same provider it was archived in (add `--no-launch` to just materialize
     it and print the resume command).

4. If the command fails because the name is taken, tell the user and ask for
   a different name — archives are immutable snapshots and are never
   overwritten.

## Notes and caveats (tell the user when relevant)

- Archive at a quiet point: no running background tasks or half-finished
  tool calls — those cannot be captured.
- The archive records the git branch + HEAD at archive time but NOT the
  working tree. If the branch moves on before a revive, the revived agent's
  memory of the tree may be stale; it should re-verify before acting.
- Transcripts can contain secrets (tokens, command output). The archive is a
  durable copy under `~/.stokd/agent-archives/` — treat it accordingly.
- Revived copies share the same working directory. Multiple concurrently
  revived copies are safe for reading/analysis; concurrent WRITERS in the
  same checkout will collide like any two agents editing one tree.

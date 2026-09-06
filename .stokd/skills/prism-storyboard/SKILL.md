---
name: prism-storyboard
description: >-
  Generate multiple Prism storyboards (section-count frames each) with Higgsfield
  Cinema Studio / best consecutive storyboard image model at 16:9 480p, save
  frames + sprite sheets under public/boards/<slug>/, and force a user pick of
  board + max resolution. Usage: /prism-storyboard with the same flags as /prism.
  Trigger on "/prism-storyboard", "prism storyboard", or as a child of /prism.
metadata:
  short-description: "Prism multi-board storyboard gen + pick gate"
---

# Prism Storyboard

Produce **B** storyboard candidates, each with **S** ordered stills matching
the stop sections (including hero). Stop for user selection.

## Contracts

- Parse args via `~/.grok/skills/prism/references/CLI.md` (or sibling
  `../prism/references/CLI.md`).
- Pipeline context: `../prism/references/PIPELINE.md`.

Bare invocation → print CLI docs for storyboard stage + examples; stop.

## Outputs

Prefer writing into the **site** when present:

```
<site-root>/public/boards/<board-slug>/
  01.<ext>
  02.<ext>
  …
  SS.<ext>          # S = section count, zero-pad 2
  board.png         # sprite sheet, storyboard layout
  meta.json         # title, themes, section names, job ids
```

If no site yet, write under:

```
<run-dir>/boards/<board-slug>/…
```

Later `/prism-site` copies boards into `public/boards/`.

Also write `<run-dir>/storyboards/index.md` listing all boards.

## Model choice

Resolve at runtime (Higgsfield MCP / `models_explore`):

1. Prefer a model **explicitly good for consecutive / storyboard / multi-frame
   keyframe consistency** if the catalog offers one.
2. Else **Cinema Studio image** family (Cinema Studio 3.5 / current Cinema
   Studio Image) — same lineage as cinematic-site stills.
3. Fall back only with user-visible note.

Generation constraints:

- Aspect **16:9**
- **480p** (preview cost gate)
- **S frames per board** (one per section, in order)
- Prefer a **single multi-image / storyboard job** per board when the model
  supports ordered frames; else sequential generations with prior-frame
  reference for continuity
- `get_cost` preflight when available for multi-board batches

## Prompt construction

For each board `b = 1..B`:

1. Invent a **title** + **slug** (2–5 words, unique in this run).
2. Write a storyboard master prompt that:
   - Uses themes + narrative from args
   - Lists **S beats** in order (section names)
   - Demands **one continuous world / camera journey**, not random shots
   - Extreme-macro / industrial / etc. only as themes dictate
   - Each panel is a potential **RPG stop frame** (stable, readable geometry)
3. Save prompt to `<run-dir>/storyboards/<slug>/prompt.txt`.

Vary boards **radically** in composition / palette / metaphor while sharing
themes — same rule as cinematic-site concept diversity.

## Sprite sheet

After frames land on disk:

- Build `board.png` as a horizontal or grid storyboard (readable on web).
- Prefer `ffmpeg`/`montage` (ImageMagick) if available; else sharp/canvas via a
  tiny node script; else CSS-less vertical strip is acceptable if labeled.

## User gate (mandatory)

Present:

```
1. <slug>: <link>
2. <slug>: <link>
…

Which storyboard do you want to use and desired max resolution (480p, 720p, 1080p, 4k).
```

Links should open `board.png` or the folder. Use `file://` paths or the local
dev server URL if the site is already serving `public/`.

**STOP** until the user replies (unless `--board` and `--res` already set).

Write choice to `<run-dir>/selection.json`:

```json
{ "board": "<slug>", "res": "1080p", "selected_at": "<iso>" }
```

## Return value to parent `/prism`

- `selection.json`
- board absolute path
- section list
- any failed board indexes

Do **not** start `/prism-videos` unless you are the parent orchestrator and the
user has answered (parent owns stage transitions).

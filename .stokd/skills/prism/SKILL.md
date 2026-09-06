---
name: prism
description: >-
  Super-skill that builds a full Prism-class RPG/scroll commercial microsite:
  storyboards → user pick → continuous film + ambient stop-loops → site scaffold
  (or stack a new visual incarnation on an existing Prism site). Usage:
  /prism 10 dark, uber macro, techno  OR  /prism --sections hero,a,b --boards 4
  --themes …  OR  /prism lucky. Also bare /prism for docs. Trigger on "/prism",
  "prism site pipeline", "prism super skill", or building a stop-loop RPG site.
metadata:
  short-description: "Prism site pipeline: storyboard → film/loops → site or incarnation"
---

# Prism (super skill)

Orchestrate a **complete Prism experience**: multi-stop camera journey film,
ambient stop-loops at each stop, and a scroll/RPG microsite — by calling child
skills in order. Do **not** free-form invent a new site architecture; child
skills own generation and the site skill pulls a packaged template.

## When bare (no args)

Print the documentation from:

- `references/CLI.md` (flags, defaults, examples)
- `references/PIPELINE.md` (stages + gates)

Then stop. Do not generate media.

## Shared contracts (read first)

1. `~/.grok/skills/prism/references/CLI.md` — parse **all** arguments here.
2. `~/.grok/skills/prism/references/PIPELINE.md` — stage order + hard gates.

If those paths are missing (skill installed elsewhere), resolve relative to this
skill’s directory (`references/CLI.md`, `references/PIPELINE.md`).

## Algorithm

### 0. Parse & materialize run

1. Parse invocation with CLI.md.
2. If docs-only → print docs, stop.
3. Create run directory; write `args.json`, `sections.json`, `themes.md`.
4. Detect **existing Prism site** (PIPELINE.md). Record `site_root` or null.

### 1. Storyboard stage

Invoke the **prism-storyboard** skill instructions end-to-end with the same
resolved args (do not invent a parallel storyboard path).

**Hard gate** — after boards exist, your user-facing message MUST be exactly
this shape (one line per board):

```
1. <board-slug>: <file:// or http link to board.png or folder>
2. <board-slug>: <link>
…

Which storyboard do you want to use and desired max resolution (480p, 720p, 1080p, 4k).
```

**STOP. Wait for the user.** Do not start videos until they answer with a board
identifier and a resolution (or explicit `--board` / `--res` were already on
the original command).

### 2. Videos stage

Invoke **prism-videos** with:

- original resolved args
- `--board <chosen-slug>`
- `--res <chosen-res>`
- `--run-dir <run>`
- `--site-root <site_root>` when detected

### 3. Site / incarnation stage

**If existing Prism site:**

1. Install media into  
   `public/media/incarnations/<incarnation-slug>/`  
   (prism-videos should already do this when `site_root` is set).
2. Append registry entry in `.prism/incarnations.json`.
3. Ensure runtime can cycle with **Shift+[** / **Shift+]** (implement or verify
   via prism-site “incarnation cycle” section — patch Experience only if missing).
4. Report: how to switch incarnations + which slug is active.

**If not an existing site:**

1. Invoke **prism-site** with run dir + board + res + sections/themes.
2. Template comes from R2 (prism-site); inject section copy + wire media.
3. `npm install` + `npm run build` must pass before declaring done.

### 4. Final report

- Run path
- Chosen board + res
- Film + loop paths
- Dev command (`npm run dev` / `npm run dev:stage -- 0`)
- Incarnation slug if stacked

## Honesty

- Verify every downloaded asset on disk (non-empty; `ffprobe` when video).
- Report failed Higgsfield jobs plainly; do not claim a board/video exists.
- Prefer cost preflight on large 4k loop batches.

## Child skills (must exist)

| Skill | Role |
|-------|------|
| `prism-storyboard` | Multi-board image sets + sprites + pick gate |
| `prism-videos` | Film, stills, ambient loops, 60fps embellish |
| `prism-site` | R2 template pull + content + incarnation cycle |

If a child skill file is missing, stop and tell the user to install the Prism
skill pack (`prism`, `prism-storyboard`, `prism-videos`, `prism-site`).

---
name: prism-videos
description: >-
  Build Prism film + ambient stop-loops from a chosen storyboard: continuous
  journey video, section stills, Seedance-class loops with start=end frames,
  optional 60fps embellish, install into public/media or an incarnation folder.
  Usage: /prism-videos --board <slug> --res 1080p [prism CLI flags]. Trigger on
  "/prism-videos", "prism loops", or as child of /prism after board pick.
metadata:
  short-description: "Prism film + stop-loops from storyboard"
---

# Prism Videos

Turn a **selected storyboard** + section list into production media matching
the Prism RPG stop-loop architecture (see prism `docs` / existing site layout).

## Contracts

- Args: `../prism/references/CLI.md`
- Pipeline: `../prism/references/PIPELINE.md`
- Required: `--board <slug>` and `--res <480p|720p|1080p|4k>` (or `selection.json`)

Bare invocation → docs for video stage; stop.

## Inputs

| Input | Source |
|-------|--------|
| Sections | `args.json` / `sections.json` |
| Themes / narrative | args |
| Board frames | `public/boards/<slug>/01..` or run-dir boards |
| Max res | user gate |

## Media layout (install targets)

### New site / first incarnation

```
public/media/
  singularity-forge.mp4          # continuous film (site name may stay generic)
  stop-loops/
    frames/stage-NN.png
    stage-NN-loop.mp4
    options/stage-NN/<id>.mp4    # optional alternates
    defaults.json
    manifest.json
```

### Existing Prism site (stack)

```
public/media/incarnations/<incarnation-slug>/
  film.mp4                       # or singularity-forge.mp4
  stop-loops/…                   # same shape as above
  meta.json
```

Also keep raw jobs under `<run-dir>/videos/`.

Map section index `i` → file slot `stage-NN` with `NN = pad(i, 2)`  
(`i=0` hero → `stage-00`).

## Generation pipeline

### 1. Film (continuous journey)

1. Author a **single continuous** video prompt from themes + board order
   (cinematic-site style: one-take language, start→end geography).
2. Prefer **image-guided** generation using board frames as key order when the
   model supports start/end/reference frames.
3. Generate at an efficient intermediate (often 480p/720p preview) only if the
   skill was asked to preview; for the post-gate path go to target `--res`.
4. Duration: scale with section count — default **~1.5–2s per section**, clamp
   total **8–16s** unless user narrative demands longer.
5. Optional **60fps embellish** via ByteDance video upscale (`fps: 60`) when
   `--res` is 1080p or 4k (same path used for singularity-forge 4k→60).
6. Install as site film; `ffprobe` verify width/height/fps/duration.

Model preference order (resolve live): Cinema Studio video / Seedance /
current catalog “journey” best — document choice in `run/videos/film.json`.

### 2. Stop stills

Extract or re-render stills at each section landing:

- Prefer **board frame i** upscaled to `--res` when continuity matters
- Or extract from final film at evenly spaced (or progress-mapped) times
- Write `frames/stage-NN.png`

### 3. Ambient stop-loops

For each section:

1. Prompt: **locked camera**, no zoom/push/parallax; ambient life only
   (fog, light flicker, speculars). Agent **may** specialize per section
   (material-specific ambience) while keeping lock language.
2. Model: Seedance-class with **`start_image` = `end_image` = stage still**
   (required for loop seam). Decline camera-move presets (“IN THE DARK”).
3. Resolution: match `--res` when the model supports it; else generate max
   available and ByteDance **upscale_video** to target.
4. Silent; duration ~3–5s raw → retime ~3s h264 `yuv420p` for browsers.
5. Install `stage-NN-loop.mp4` + optional `options/stage-NN/4k-v1.mp4` (or res tag).

Write prompts to `<run-dir>/videos/loop-prompts/stage-NN.txt`.

### 4. Manifest + defaults

Update/write:

- `manifest.json` — filmTimeSec, progress, loop dims, provenance job ids
- `defaults.json` — all stages `live` unless user prefs exist
- If site has `src/experience/stopLoops.ts`, **register** new option ids or
  reset catalog to `live` + current take (mirror prism 4k regen approach).

### 5. Incarnation registry (existing site)

If `site_root` set:

1. Choose `incarnation-slug` from board slug + short hash/time
2. Write `meta.json` (themes, board, res, created)
3. Update `.prism/incarnations.json`
4. Do **not** destroy prior incarnations

## Agent optionality (loops)

Allowed without re-asking:

- Per-stage ambience vocabulary (coolant vs gold lattice vs fog)
- Reverse-friendly motion vs pure flicker
- One alternate take per stage if credits allow (`options/`)

Not allowed without user ask:

- Deleting other incarnations
- Spending unbounded 4k batches beyond section count (+1 alternate)

## Verification

For every loop and the film:

```bash
ffprobe -v error -show_entries stream=width,height,r_frame_rate -show_entries format=duration,size -of default=noprint_wrappers=1 <file>
```

Non-empty files only. Prefer mid-clip PSNR motion check when `ffmpeg` available
(see existing stop-loops README pattern).

## Return

Paths + job ids + incarnation slug + note if site runtime still needs
incarnation cycle wiring (parent/prism-site responsibility).

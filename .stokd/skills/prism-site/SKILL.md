---
name: prism-site
description: >-
  Scaffold or upgrade a Prism RPG/scroll microsite from a packaged R2 template
  (not a free-form rebuild prompt): inject section copy from themes/sections,
  wire film + stop-loops, multi-incarnation cycle (Shift+[ / Shift+]), dev:stage
  pin. Usage: /prism-site [prism CLI flags] --run-dir … after videos exist.
  Trigger on "/prism-site", "prism template site", or as child of /prism.
metadata:
  short-description: "Prism site from R2 template + incarnation cycle"
---

# Prism Site

Build or extend the **site shell**. Visual media is owned by `/prism-videos`.
This skill packages an artfully designed baseline (template) and injects content.

## Contracts

- Args: `../prism/references/CLI.md`
- Pipeline: `../prism/references/PIPELINE.md`
- Template: `references/TEMPLATE.md` (R2 URL + layout expectations)

Bare invocation → docs; stop.

## Template source (not a bespoke generation prompt)

1. Read `references/TEMPLATE.md` for the **canonical R2 base URL** and version.
2. Download/extract the template into the target directory:
   - New project: create `./` or user-specified folder (default `./prism-site` or
     `~/prism-runs/.../site`)
   - Never hand-author a full Vite app from scratch if the template is reachable
3. If R2 is unreachable, fall back to cloning structure from a known local
   reference (`prism/main` or `apps/web-front-end-v2`) **only** as emergency,
   and say so.

Template contains: Experience RPG/FPS, stop-loops wiring, PromptPage, rail,
telemetry, `dev:stage`, climax blend patterns, incarnation loader hooks.

## Content injection

From run `sections.json` + `themes.md` (+ optional lucky brief):

1. Generate **chapter/section copy** (headings, bodies, readouts, accents)
   aligned to section names — editorial, specific, not lorem.
2. Write into template content modules (e.g. `src/experience/chapters.ts` or
   `src/experience/content/<incarnation>.ts`).
3. If sections were not user-named, keep `hero` / `stage-N` labels but invent
   evocative marketing titles from themes.
4. Brand: invent a plausible commercial brand from themes unless the narrative
   names one. Do not reuse “Oates Ames” unless themes demand stokd marketing.

## Media wiring

1. Point film src at installed film path.
2. Ensure `stopLoops.ts` (or data-driven catalog) lists slots for all sections.
3. `defaults.json` + `manifest.json` consistent with media on disk.
4. Copy storyboard folder into `public/boards/` if still only in run-dir.

## Multi-incarnation support (required)

Implement or verify:

### Storage

```
public/media/incarnations/<slug>/…
.prism/incarnations.json
.prism/site.json            # { "templateVersion", "defaultIncarnation" }
```

### Runtime

- Load active incarnation from `localStorage` (`prism.incarnation` / `oa.incarnation`)
- **Shift+]** next, **Shift+[** previous (wrap)
- Optional telemetry `INC` readout
- On switch: swap film src + stop-loop base path + chapter content if per-incarnation

### First site

Create incarnation `default` (or board slug) as the only entry.

## Dev ergonomics

Keep / add:

- `npm run dev:stage -- <n>` pin
- `?stage=` + sessionStorage
- RPG hone-in chrome (STAGE / RES / LOOP / DIR / DEFAULTS) when template has it

## Build gate

```bash
npm install
npm run build
```

Must pass before success. Fix TypeScript errors in-place.

## Do not

- Re-run storyboard or video generation (call those skills instead)
- Overwrite unrelated user code outside template-managed paths without asking
- Delete existing incarnations

## Return

- Site path
- `npm run dev` command
- Default incarnation
- How to cycle visuals (Shift+[ / ])

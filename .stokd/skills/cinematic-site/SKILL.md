---
name: cinematic-site
description: >-
  End-to-end pipeline for premium scroll-driven commercial landing pages built
  around a single continuous 8-second extreme-macro video journey: ideate N
  radically different concepts, author a video-model prompt per concept, render
  8s 480p previews with Cinematic Studio 3.5, stop for user selection, finalize
  the winners at 1080p and interpolate to 60fps with ByteDance AIGC, then build
  one complete scroll-scrubbed React/Vite/GSAP microsite per final video.
  Usage: /cinematic-site <number> [optional directional nudge]. Trigger on
  "/cinematic-site", "cinematic site pipeline", or "macro video landing page".
metadata:
  short-description: "Macro-video landing-page pipeline: ideate → preview → select → finalize → build site"
---

# Cinematic Site

Turn `/cinematic-site <number> [nudge]` into finished, award-grade commercial
microsites, each driven by a single continuous 8-second extreme-macro video.
The pipeline has five stages with ONE hard user gate (Stage 3). Never skip a
stage, never reorder them, and never render at 1080p before the user has
selected winners from the 480p previews.

## Arguments

Parse the raw invocation text positionally — never require quotes:

1. First whitespace-delimited bare integer → `COUNT` (number of concepts).
   Clamp to 1–10. If absent, default `COUNT = 3`.
2. Everything remaining after `COUNT` → `NUDGE`, an optional directional
   steer (e.g. "make these versions take place inside an ASML EUV machine",
   "all underwater", "brutalist, monochrome"). May be empty.

## Run directory

All artifacts for one invocation live under a single run directory in the
user-level cinematic-site home — NEVER inside the repo/workspace you were
launched from (run artifacts must not be committed to a codebase):

```
~/cinematic-site/<YYYYMMDD-HHMMSS>/
  concepts.md              # Stage 1 output — the N concepts
  prompts/<slug>.txt       # Stage 2 output — one video prompt per concept
  previews/<slug>-480p.mp4 # Stage 3 output
  finals/<slug>-1080p.mp4  # Stage 4 render
  finals/<slug>-60fps.mp4  # Stage 4 interpolated final
  sites/<slug>/            # Stage 5 — one standalone project per final
```

Derive `<slug>` from each concept's title (lowercase, hyphenated, 2–4 words).

## Stage 0 — Resolve the video backends (before any rendering)

Two backends are required. Resolve each at runtime, in this order:

1. An MCP tool exposed in the session whose name/description matches the
   backend (search the available tools first).
2. A local CLI on PATH.
3. A direct HTTP API for which a key is present in the environment.

Backends:

- **Generation — Cinematic Studio 3.5**: text-to-video. Stage 3 calls it at
  8 seconds / 480p; Stage 4 calls it at 8 seconds / 1080p with the identical
  prompt and, when supported, the same seed as the selected preview.
- **Interpolation — ByteDance AIGC frame interpolation**: video-to-video,
  interpolates the 1080p output to 60fps.

If a backend cannot be resolved, STOP before the stage that needs it and
report exactly what is missing (tool name searched, CLIs probed, env keys
checked) and what the user must provide. NEVER fabricate a render, substitute
a placeholder/stock video, or claim an output exists that you did not verify
on disk (check the file exists and is non-empty; probe duration/resolution
with `ffprobe` when available). Stages 1–2 are pure writing and always run.

## Stage 1 — Ideation

Act as the creative director. Generate the concepts using this prompt,
substituting `COUNT` and appending `NUDGE` when present:

> You're the sole creative director and senior frontend author for a premium
> interactive portfolio.
>
> Give me creative ideas (videos) for [COUNT] radically different,
> scroll-driven commercial landing pages.
>
> The video must involve a single, continuous 8-second extreme macro camera
> journey. This journey is what we'll use as the main, captivating feature of
> our websites, so make these as interesting as possible. [NUDGE]

Requirements for the output (write it to `concepts.md`):

- Exactly `COUNT` concepts, each radically different from the others in
  material world, temperament, and palette — not variations on one idea.
- Each concept must include: a short evocative title, the 8-second macro
  journey described beat by beat as ONE continuous camera move (no cuts),
  the scroll behavior the site will use, and a palette note.
- Extreme macro means extreme: fibers, droplets, strata, molecular texture —
  scale is the spectacle.

## Stage 2 — Author one video-model prompt per concept

For EACH concept, generate a high-quality macro-video prompt for an advanced
video model. Follow the construction of this exemplar — one single sentence-
flow paragraph, forward motion, explicit start → travel → end geography,
material and lighting language, and the same closing quality clauses:

> "Single continuous 8-second cinematic engineering shot moving forward from
> above a stormy cold North Atlantic ocean, descending smoothly beneath the
> waves through bubbles and suspended particles, approaching a monumental
> steel tidal turbine anchored to the rocky seabed, camera passing through
> the center of its slowly rotating structure with powerful water currents
> visible, continuing forward beside glowing subsea electrical transmission
> cables across the seabed, entering a vast concrete seawall conduit, ending
> emerging toward a realistic coastal city at blue hour as thousands of warm
> city lights activate, photorealistic documentary cinematography, physically
> accurate materials, strong forward parallax, seamless one-take motion, no
> cuts, restrained natural color."

Rules per prompt:

- Begin with "Single continuous 8-second …" and describe one unbroken camera
  journey matching that concept's beats.
- Name concrete materials, scale cues, and light sources; no abstract
  adjectives without a physical referent.
- End with quality clauses tuned to the concept (e.g. "extreme macro lens,
  physically accurate materials, strong forward parallax, seamless one-take
  motion, no cuts" plus a color-discipline clause).
- Write each to `prompts/<slug>.txt`.

## Stage 3 — 480p previews, then STOP for selection (hard gate)

1. Submit every prompt to Cinematic Studio 3.5 at **8 seconds, 480p**. Save
   each result to `previews/<slug>-480p.mp4` and verify it exists on disk.
2. Present the results to the user: for each concept show the title, a
   one-line recap, the preview file path, and the prompt used. Send the
   preview files to the user when a file-sending tool is available.
3. **STOP. Await explicit selection.** The user picks one or multiple
   winners. Do not proceed to Stage 4 for any concept the user did not
   select, and never start a 1080p render before selection. If a preview
   render failed, report it alongside the successes — the user may ask for a
   retry or drop the concept.

## Stage 4 — Finalize the winners

For each selected concept:

1. Re-run the SAME prompt (unchanged text; reuse the preview's seed if the
   backend supports it) through Cinematic Studio 3.5 at **8 seconds, 1080p**
   → `finals/<slug>-1080p.mp4`.
2. Run the 1080p output through ByteDance AIGC frame interpolation to
   **60fps** → `finals/<slug>-60fps.mp4`.
3. Verify both files on disk (`ffprobe` for resolution/fps when available)
   before calling the stage done.

The 60fps file is the final deliverable video for Stage 5.

## Stage 5 — Build one site per final video

For each final video, build a complete standalone project at
`sites/<slug>/`:

1. Copy `finals/<slug>-60fps.mp4` to `sites/<slug>/public/media/<slug>.mp4`.
2. Read `references/site-build-prompt.md` (bundled with this skill). Fill its
   two placeholders:
   - `VIDEO_FILENAME` → `<slug>.mp4`
   - `CONCEPT` → the full concept text from Stage 1 plus the Stage 2 video
     prompt for that slug.
3. Execute the filled prompt faithfully as the build brief — you are the
   "Claude" it addresses. When running with subagent support, build the sites
   in parallel (one subagent per site, each given the filled prompt and its
   own `sites/<slug>/` directory); otherwise build sequentially.
4. Each site must finish with `npm install` and a passing `npm run build`
   (zero TypeScript errors) before it is reported as done.

Report at the end: per site, the path, the build result, and the command to
preview it (`npm run dev`). Do not deploy unless the user asks.

## Honesty rules

- A stage is complete only when its artifacts are verified on disk.
- Report failed renders, missing backends, and failed builds plainly, with
  the error — never paper over a gap to keep the pipeline moving.
- Costs are real: the 480p gate exists so the user chooses before expensive
  1080p renders. Respect it even when told to "hurry".

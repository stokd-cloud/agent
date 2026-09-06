# Prism super-skill pipeline

```
/prism  [args]
   │
   ├─► resolve args (see CLI.md)
   ├─► create run dir + args.json
   │
   ├─► /prism-storyboard  (same args)
   │      • invent N storyboards (N = --boards)
   │      • each board has S frames (S = section count)
   │      • Cinema Studio image (or better storyboard model)
   │      • 16:9 · 480p frames
   │      • write public/boards/<slug>/{01..S}.ext + board.png sprite
   │      • HARD GATE: user picks board + max res
   │
   ├─► /prism-videos  --board <slug> --res <res> (+ args)
   │      • continuous film from board (text+keyframes path)
   │      • stop stills at section landings
   │      • ambient loops start=end still (Seedance-class)
   │      • optional 60fps embellish (ByteDance upscale fps)
   │      • install under run media + site public/media
   │
   └─► if existing Prism site:
          add incarnation + Shift+[ / Shift+] cycle
       else:
          /prism-site  (pull R2 template, inject content, wire media)
```

## Hard rules

1. **Never skip the storyboard pick gate** unless user pre-passes `--board <slug>` and `--res`.
2. **Never spend paid Higgsfield** without the user having invoked the skill with generative intent (args / lucky count as intent). Prefer `get_cost` preflight for large 4k batches when available.
3. **Never invent board selection** — wait for the user line.
4. Child skills are independently invocable with the same CLI contract.
5. Site chrome/code comes from the **packaged template** (R2), not a free-form rebuild prompt.

## Existing-site detection

Treat cwd (or nearest git root) as an existing Prism site when **any** of:

- `.prism/site.json` exists
- `src/experience/Experience.tsx` AND `public/media/stop-loops/` exist
- package.json name is `prism` or description contains prism-experience

## Incarnations (multi-visual sets)

Each completed `/prism-videos` (or full `/prism`) on an existing site adds:

```
public/media/incarnations/<incarnation-slug>/
  singularity-forge.mp4          # or film.mp4
  stop-loops/
    frames/stage-*.png
    stage-*-loop.mp4
    defaults.json
    manifest.json
  meta.json                      # title, themes, board slug, res, created
```

Registry: `.prism/incarnations.json` lists ordered slugs; active slug in `localStorage` key `oa.incarnation` (or `prism.incarnation`).

Keyboard (site runtime — `/prism-site` must ensure this exists):

- **Shift+[** → previous incarnation  
- **Shift+]** → next incarnation  
- Telemetry may show `INC` slug

## Artifact ownership

| Artifact | Location |
|----------|----------|
| Run args, prompts, job ids | run dir |
| Storyboard frames + sprites | `<site>/public/boards/<slug>/` (or run dir `boards/` if no site yet, then copied) |
| Film + loops | incarnation folder or `public/media/` for first site |
| Template | pulled once into site scaffold by `/prism-site` |

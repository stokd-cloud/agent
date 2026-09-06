# Prism CLI argument contract

**Single source of truth** for `/prism`, `/prism-storyboard`, `/prism-videos`, and `/prism-site`.  
Child skills MUST parse args using this contract — do not invent a second grammar.

## Invocation shapes

Bare skill name (or skill name with only whitespace) → print **docs** and stop.

```
/prism
/prism-storyboard
/prism-videos
/prism-site
```

Lucky mode (random agent-authored sections + themes + defaults):

```
/prism lucky
/prism feeling-lucky
```

Shortcut form (common):

```
/prism <N> <themes…>
```

Example: `/prism 10 dark, uber macro, techno, ai, universe`

Means:

- `--sections 10` (hero + 9 later stops, named `hero`, `stage-1` … `stage-9`)
- `--themes dark, uber macro, techno, ai, universe`
- `--boards` defaults to section count (`10`)

Full flag form:

```
/prism --sections hero,cold-start,axioms,gate,fleet,horizon,climax \
       --boards 8 \
       --themes dark, uber macro, techno \
       --res 1080p \
       --narrative optional free text of what the journey should feel like
```

## Flags

| Flag | Type | Default | Meaning |
|------|------|---------|---------|
| `--sections` | int **or** comma-list of names | `7` | Stop count including **hero**, or explicit stop names |
| `--boards` | int | = section count | Number of distinct storyboard candidates |
| `--themes` | comma-list (and/or free prose after flags) | (required unless lucky) | Styles, camera, lens, palette, mood, domain |
| `--narrative` | free text | empty | Optional explicit journey brief layered on themes |
| `--res` | `480p` \| `720p` \| `1080p` \| `4k` | asked at video gate | Max final video resolution (not used at storyboard stage) |
| `--run-dir` | path | auto | Override run directory |
| `--incarnation` | slug | auto from board title | Name for this visual set when stacking on an existing site |
| `lucky` / `feeling-lucky` | bare token | off | Agent invents sections + themes + narrative |

Positional shorthand (when first token is an integer and no `--sections`):

1. `N` → `--sections N`
2. remainder → `--themes` (+ narrative if clearly prose)

## Sections parsing

1. If `--sections` is a **positive integer** `N` (clamp 2–16):  
   - Count = `N`  
   - Names = `hero`, `stage-1`, `stage-2`, … `stage-(N-1)`
2. If `--sections` is a **comma-separated list**:  
   - Split on commas, trim, slugify for filenames  
   - First name is always the **hero** stop (even if not literally `hero`)  
   - Count = list length (clamp 2–16)
3. If omitted: same as `--sections 7` → `hero`, `stage-1` … `stage-6`

## Themes parsing

- Prefer `--themes a, b, c`
- Also accept free tokens after positional `N` as themes
- Commas optional; join remaining tokens into a theme bag
- Store both:
  - `themes[]` array of short tags
  - `theme_line` single string for prompts

## Lucky mode

When `lucky` or `feeling-lucky` is present (and no conflicting explicit `--sections`/`--themes` required):

1. Agent invents a coherent world (brand + material + camera language)
2. Sections default to 7 unless `--sections N` also given
3. Themes + a short narrative are written to `run/lucky-brief.md`
4. Proceed as if user supplied them

## Resolution options (for the board-pick gate)

Present exactly:

`480p, 720p, 1080p, 4k`

Map to Higgsfield generation / upscale targets used by `/prism-videos`.

## Run directory

Default:

```
~/prism-runs/<YYYYMMDD-HHMMSS>-<short-slug>/
```

If cwd is already a Prism site (detect `src/experience/Experience.tsx` + `public/media/stop-loops/` **or** `.prism/site.json`):

```
<site-root>/.prism/runs/<YYYYMMDD-HHMMSS>-<short-slug>/
```

Always write `run/args.json` with the resolved contract so child skills are deterministic.

## Docs output (no args)

When printing docs, include:

1. Purpose of the skill
2. All flags + defaults
3. Examples (shortcut, full flags, lucky)
4. Hard gates (storyboard pick, optional video QA)
5. Downstream skills called

# Prism site template (R2)

## Canonical package

| Field | Value |
|-------|--------|
| **Base URL** | `https://pub-prism-templates.r2.dev/prism-site/` *(placeholder — replace with real public R2 bucket URL when published)* |
| **Manifest** | `{base}/manifest.json` |
| **Tarball / zip** | `{base}/releases/{version}/prism-site.tgz` |
| **Pinned version key** | `latest` → redirects or lists current semver |

### manifest.json shape (expected)

```json
{
  "name": "prism-site-template",
  "version": "1.0.0",
  "artifact": "releases/1.0.0/prism-site.tgz",
  "sha256": "<hex>",
  "min_skill_pack": "2026-08-12",
  "features": ["rpg-stop-loops", "incarnations", "dev-stage", "defaults-api"]
}
```

## Local fallback (dev / offline)

If R2 is unset or fetch fails, in order:

1. Env `PRISM_TEMPLATE_PATH` → directory or tarball on disk  
2. Env `PRISM_TEMPLATE_URL` → override base URL  
3. Sibling worktree `/opt/worktrees/stokd-cloud/prism/main` (copy tree excluding
   `node_modules`, `dist`, large `_archive*`, `.git`)  
4. mono `apps/web-front-end-v2` as last resort

Always record which source was used in `.prism/site.json`.

## Publishing a new template (human / ops)

1. Start from a clean Prism site with incarnation support + empty media placeholders.
2. Strip private keys, `node_modules`, `dist`, session-only files.
3. Ship `public/media` with **tiny placeholders** only (or omit and let videos skill fill).
4. Upload tarball + update `manifest.json` + `latest`.
5. Bump `version` in this file when the skill pack requires template APIs.

## Required template touchpoints for skills

| Path | Why |
|------|-----|
| `src/experience/Experience.tsx` | RPG/FPS, incarnation switch hooks |
| `src/experience/stopLoops.ts` | catalog + prefs |
| `src/experience/chapters.ts` or content modules | inject copy |
| `src/experience/devStage.ts` | stage pin |
| `public/media/stop-loops/` | media root |
| `public/media/incarnations/` | multi-set root |
| `scripts/dev-stage.mjs` | dev UX |
| `vite.config.ts` | defaults API if present |
| `.prism/site.json` | written by skill |

## Content injection API (template authors)

Prefer data files over rewriting logic:

```
src/experience/content/default.json
src/experience/content/<incarnation>.json
```

Shape sketch:

```json
{
  "brand": { "name": "", "lot": "", "tagline": "" },
  "sections": [
    { "id": "hero", "code": "00", "stage": "…", "heading": "…", "body": "…",
      "readouts": [{"label":"","value":""}], "accent": "#…" }
  ],
  "climax": { "title": "", "figures": [] }
}
```

Skills write these JSON files; runtime loads active incarnation’s content.

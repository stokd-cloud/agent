# Prism examples

## Docs

```
/prism
```

## Shortcut — 10 stops + theme bag

```
/prism 10 dark, uber macro, techno, ai, universe
```

- sections: 10 (`hero` … `stage-9`)
- boards: 10
- themes: dark · uber macro · techno · ai · universe

## Explicit sections + fewer boards

```
/prism --sections hero,cold-start,gate,fleet,singularity \
       --boards 3 \
       --themes noir, wet metal, anamorphic, cold LED
```

## Lucky

```
/prism lucky
/prism feeling-lucky --sections 8
```

## Standalone children

```
/prism-storyboard 7 brutalist, subterranean, acid green
/prism-videos --board subterranean-core --res 1080p --sections 7 --themes …
/prism-site --run-dir ~/prism-runs/… 
```

## Stack on existing site

From a Prism project directory:

```
/prism 6 bioluminescent, deep sea,  macro lens
```

After pick + videos → new `public/media/incarnations/<slug>/`  
Cycle with **Shift+[** / **Shift+]**.

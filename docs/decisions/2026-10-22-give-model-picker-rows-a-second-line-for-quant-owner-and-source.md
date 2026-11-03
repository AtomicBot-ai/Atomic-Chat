---
date: 2026-10-22
title: "Give model picker rows a second line for quant, owner and source"
---

# 2026-10-22 — Give model picker rows a second line for quant, owner and source

- **Context:** QA 09 (2.2.23 UI review). The composer's model list showed each
  installed model as one truncated line, `qualifiedModelDisplayName` —
  "ollama/Gemma 4 12B Uncensored Heretic … q4_K_M" — with the source badge
  beside it. The badge kept its width, so the ellipsis ate the end of the
  name, and the quant at the end was the first thing to go. Two quants of
  one repo, or one model from two owners, could read the same. The popover
  is 22rem wide and must not grow.
- **Decision:** Each row is two lines. Line 1 is the model's name,
  `compactModelDisplayName` (a nickname, or the cleaned name with no owner
  and no quant). It wraps to two lines at most and is clamped at the end.
  Line 2 is small and muted: the quant as the file spells it, then the
  repository owner (the first id segment only, not the whole repo path),
  then the source badge. `modelVariantDetails` in `lib/model-display-name`
  leaves out a quant or owner that a nickname already reads. The owner is
  also left out when the badge names the same thing (`ollama/…` from the
  Ollama scan). A row with nothing for line 2 stays one line. The `title` is
  still the full id. The option's accessible name is the visible parts
  followed by the full id in parentheses. Favorites use the same row, with
  the engine's avatar. Search, selection, keyboard focus and the popover's
  width did not change.
- **Consequences:** The quant and the owner are always visible, and the
  badge no longer takes width from the name. Rows are taller (about 48 px
  instead of 32 px), so fewer fit in the fixed-height list before it
  scrolls. Rows with and without a second line differ in height. The model
  row on the panel's first view still shows the one-line qualified name. It
  holds a single model and has no badge. Two files whose name, quant and
  owner all match differ only in the tooltip and the accessible name. The
  layout test is
  `DropdownModelProvider.variants.layout.test.tsx`: every quant and the
  long name must lie inside the boxes that clip them, at 1024/1280 px,
  Medium/Extra Large, light/dark.
- **Owner:** `team`.
- **Links:** `web-app/src/containers/DropdownModelProvider.tsx`,
  `web-app/src/lib/model-display-name.ts`,
  `web-app/src/containers/DropdownModelProvider.variants.layout.test.tsx`,
  `web-app/src/containers/__tests__/DropdownModelProvider.variants.test.tsx`

---
date: 2026-10-22
title: 'Show only the generation settings a recipe can vouch for'
---

# 2026-10-22 — Show only the generation settings a recipe can vouch for

- **Context:** a provider's media model is sent only the knobs it takes. The
  core still writes every recipe field: for a remote image `steps` and
  `cfgScale` become 0 and `seed` / `batchSeed` -1 when they were not sent
  (`atomic-chat-core` `src/diffusion/remote-job.ts`), and a remote clip
  records the form's `steps` / `cfgScale` (never sent) and seed -1. The
  Images Details popover printed them, so a Nano Banana 2.1 picture from
  OpenRouter showed "Steps 0, CFG 0, Seed -1" as if they were its settings
  (QA 2.2.23, finding 13). Video already hid remote steps and CFG, not the
  seed.
- **Decision:** Details shows a steps, CFG, seed or batch-seed row only when
  the recipe can vouch for it (`imageRecipeSettings` in
  `web-app/src/lib/diffusion/recipe.ts`, `videoRecipeSettings` in
  `web-app/src/lib/video/recipe.ts`). A local engine's numbers are shown as
  recorded, zeros included. For a remote engine a step count or CFG counts
  only above zero and a seed only at zero or more, since that is all the core
  ever sends or draws; a remote clip's steps and CFG never count. A field a
  recipe leaves out is not provided. Rows are hidden rather than shown as
  "Not provided", like the guidance and sampler rows already were.
- **Consequences:** old pictures and clips saved with the placeholders read
  correctly without a migration. At the source, core 0.18.9 leaves the knobs
  a provider was not sent out of its recipe and makes them optional in the
  contract (core ADR 2026-10-22-leave-unsent-knobs-out-of-a-remote-recipe);
  the app's `ImageRecipe` / `VideoRecipe` mirror that. The same rule drives
  Restore and the export name: `restoreDraftFromRecipe` /
  `restoreVideoDraftFromRecipe` leave an unvouched steps, CFG or seed out of
  the draft, so `applyDraft` keeps the form's own value, and
  `exportFilename` / `exportVideoFilename` drop the seed segment instead of
  writing `_-1`.
- **Owner:** team
- **Links:** `web-app/src/containers/images/ImageRecipePopover.tsx`,
  `web-app/src/containers/videos/VideoRecipePopover.tsx`, ADR
  2026-10-13-offer-providers-media-models-beside-the-local-ones.md.

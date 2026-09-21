---
date: 2026-09-17
title: 'Keep the model-ready snackbar compact'
---

# 2026-09-17 — Keep the model-ready snackbar compact

- **Context:** The loaded face reused a model-name title and the loading
  snackbar's 480 px shell. Long repository/model names made a brief success
  notice much larger than the app's standard Sonner notifications.
- **Decision:** Show “Model ready” above “Loaded into memory”, with a 20 px
  success icon centered beside the text block. Only the loaded face uses
  Sonner's inherited standard width (`--width`, currently 356 px), retaining
  the viewport cap. The starting face keeps its approved copy, loader,
  Cancel, dismiss button, and width.
- **Consequences:** Success geometry is independent of model names. A CSS
  `:has` rule changes the existing toast shell's width without recreating it
  or changing the three-second dismissal lifecycle. English keys are added
  under `common:modelLoad`; other locales use the existing English fallback.
- **Owner:** team.
- **Links:** `web-app/src/containers/ModelLoadSnackbar.tsx`,
  `web-app/src/containers/ModelLoadSnackbar.layout.test.tsx`,
  [Original model-loading UI](2026-09-15-say-what-a-model-load-is-waiting-on-and-let-it-be-cancelled.md).

---
date: 2026-09-17
title: 'Keep model-loading snackbar copy stable across stages'
---

# 2026-09-17 — Keep model-loading snackbar copy stable across stages

- **Context:** The loading snackbar translated every internal stage into a
  different subtitle, including cache state and memory retry details. Latest
  product feedback requests the same copy throughout both loads and restarts.
- **Decision:** Every nonterminal loading stage shows “Starting Model” above
  “Loading model into memory”. Stage, cache fraction and retry values remain
  in progress/status objects; backend events, logs and telemetry are unchanged.
  This supersedes only the stage-specific snackbar copy in the original
  [model-loading decision](2026-09-15-say-what-a-model-load-is-waiting-on-and-let-it-be-cancelled.md).
- **Consequences:** Stage transitions no longer change visible snackbar copy
  or geometry. Cancel, cancelling, dismiss, actionable terminal errors and the
  “Model ready” / “Loaded into memory” success lifecycle remain unchanged.
  A single English subtitle key replaces the unused English stage-copy keys;
  other locales use the existing fallback for the new key.
- **Owner:** team.
- **Links:** `web-app/src/containers/ModelLoadSnackbar.tsx`,
  `web-app/src/containers/__tests__/ModelLoadSnackbar.test.tsx`,
  `web-app/src/containers/ModelLoadSnackbar.layout.test.tsx`.

<!--
Supersedes (snackbar stage copy only): 2026-09-15-say-what-a-model-load-is-waiting-on-and-let-it-be-cancelled.md
-->

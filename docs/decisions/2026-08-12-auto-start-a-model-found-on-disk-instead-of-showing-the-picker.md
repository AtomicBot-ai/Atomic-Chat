---
date: 2026-08-12
title: "Auto-start a model found on disk instead of showing the onboarding picker"
---

# 2026-08-12 — Auto-start a model found on disk instead of showing the onboarding picker

- **Context:** onboarding scanned LM Studio / HF cache / Unsloth / Ollama and
  listed what it found above the recommended catalog models, but the user still
  had to read two sections and press a button — and the Download column invited a
  multi-gigabyte download next to models they already had. First launch cost a
  decision that had only one sensible answer.
- **Decision:** when the scan finds at least one runnable model, onboarding never
  renders the picker: it imports and launches the smallest runnable candidate
  right away and shows only a "Starting …" line. The picker (detected rows +
  recommended downloads) is rendered only when nothing was found or when the
  auto-started import fails. Smallest wins because it loads fastest; candidates
  with an unknown size sort last.
- **Consequences:** the fastest path to a working chat costs zero clicks for users
  coming from another local-LLM app, and the download offer no longer competes
  with weights already on disk. The user no longer chooses which detected model
  runs first — the rest are still imported in the background, so switching is a
  model-picker click away. `setup_screen_shown` is suppressed on this path
  (the screen is not shown) and replaced by `setup_local_model_autostarted`, so
  onboarding funnels must read both events. The 15s auto-exit stays disarmed
  while the import is in flight, as it already was for a manual Run.
- **Owner:** `team`
- **Links:** `web-app/src/containers/SetupScreen.tsx`,
  `web-app/src/services/models/localScan.ts`,
  `web-app/src/containers/__tests__/SetupScreen.test.tsx`

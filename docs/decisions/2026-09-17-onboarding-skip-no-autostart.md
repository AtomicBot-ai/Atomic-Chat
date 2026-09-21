---
date: 2026-09-17
title: "Keep model selection empty after skipping onboarding"
---

# 2026-09-17 — Keep model selection empty after skipping onboarding

- **Context:** Forced onboarding can show setup with downloaded models and a persisted selection. Skip cleared the last-used entry but retained that selection, which ChatInput automatically started. With startup preloading enabled, the model picker could also select the first installed model after Skip.
- **Decision:** Leaving setup without choosing a model clears the selected model/provider and defers automatic picker initialization for the current session. Explicit model selections and download handoffs continue to work. The preload preference, installed files, provider configuration, and model settings are preserved.
- **Consequences:** The composer shows Select Model after Skip, including after library refreshes and picker remounts. The deferral is in the non-persisted model-load store; the next application launch follows the existing preload preference. Existing detected-model import/autostart behavior before a skip and explicit download completion behavior are unchanged.
- **Owner:** team.
- **Links:** `web-app/src/containers/SetupScreen.tsx`, `web-app/src/containers/DropdownModelProvider.tsx`, `web-app/src/hooks/useModelLoad.ts`.

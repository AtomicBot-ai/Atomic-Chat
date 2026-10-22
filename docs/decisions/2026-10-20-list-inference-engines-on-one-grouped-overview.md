---
date: 2026-10-20
title: 'List the inference engines on one grouped overview'
---

# 2026-10-20 — List the inference engines on one grouped overview

- **Context:** After [the icon rail](2026-10-19-navigate-with-an-icon-rail-and-a-contextual-sidebar.md),
  the Models Hub sidebar carried a row per local engine (green dot on the
  provider behind the selected model), a "N disabled" fold for the engines
  that are off, and Media and Voice rows. `/settings/providers` was an
  unlinked card list with a gear and a switch per engine. The approved
  prototype has one "Inference engines" row and an overview grouped by what
  the engines serve; its rows are expandable cards with Start/Stop/Restart
  and inline engine settings, all on local state.
- **Decision:** The Models Hub sidebar gets one "Inference engines" row
  (after Custom Endpoint); it stays highlighted on the overview, on every
  `/settings/providers/$providerName` and on `/settings/media` and
  `/settings/voice`. `/settings/providers` becomes the overview, in three
  groups:
  - **Language models** — the same engines the sidebar listed, by the same
    rules: local engine providers only (cloud, Ollama and custom endpoints
    stay under Cloud providers), MLX on macOS only, `llamacpp` behind
    `TURBOQUANT_ENGINE`, managed engines once their extension shows them
    (the page still runs `refreshAppManagedProviders` on open). A row shows
    the model count, the active build and an "Update available" badge from
    the engine-versions store (the core's answer; the badge is
    `engineUpdateOfferFrom`, not the banner's snooze), the status, and the
    enable switch with today's logic (turning `llamacpp` off stops every
    model first). The card opens `/settings/providers/$providerName`, which
    is unchanged.
  - **Media models** — stable-diffusion.cpp: its build, update badge and
    status; the existing `MediaSettingsPanel` unfolds inside the card.
  - **Voice models** — Voxtral on llama.cpp; the existing
    `VoiceSettingsPanel` unfolds inside the card.

  Status is read, not offered: Running while the engine has a model loaded
  (`getActiveModels(provider)`, asked again whenever the app's loaded models
  change; for Media the image store's loaded model; for Voice the Voxtral
  model among llama.cpp's), Idle otherwise, Disabled for an engine that is
  off, Not installed for a voice model that is not downloaded.

- **Consequences:**
  - No Start, Stop or Restart buttons: an engine has no lifecycle of its
    own to drive — it runs while a model is loaded on it — and the
    prototype's buttons only flipped local state. Unloading stays on the
    engine's page and in the model picker.
  - The prototype's inline language-engine settings are not ported: they
    wrote `controller_props` into the provider store without calling
    `providers().updateSettings`, so the engine never saw them. Settings
    stay on the engine's page.
  - The sidebar's per-engine rows, their selected-provider dot and the
    disabled fold are gone; the model picker still marks the provider behind
    the selected model. `/settings/media` and `/settings/voice` stay as
    routes for anything that links there.
  - Not a return of the
    [2026-08-13 Settings rework](2026-08-13-revert-the-settings-and-model-providers-ui-rework-keep-runtime.md):
    there is no `/settings` layout route, `useModelProvider` and its persisted
    shape are untouched, the engine settings are not hidden or split, and
    `/settings/providers/$providerName` remains the full engine surface. Only
    the sidebar's row per engine, which that record restored, becomes one row
    and a page.
  - Desktop E2E reaches engines through the overview
    (`openInferenceEngines`, `openEnginePage`, `openMediaEngineSettings` in
    `tests/e2e/harness/navigation.ts`).
- **Owner:** team
- **Links:** `web-app/src/containers/engines/InferenceEnginesOverview.tsx`,
  `web-app/src/routes/settings/providers/index.tsx`,
  `web-app/src/components/left-sidebar/index.tsx`,
  `web-app/src/containers/SettingsMenu.tsx`,
  [Take engine versions from the core](2026-10-08-take-engine-versions-from-the-core-and-update-through-it.md)

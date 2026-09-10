---
date: 2026-08-18
title: "Delete an installed model from the Hub download panel"
---

# 2026-08-18 — Delete an installed model from the Hub download panel

- **Context:** removing a downloaded model was only reachable from Settings →
  Model Providers → *provider* (`DialogDeleteModel`). The Models screen in the
  sidebar points at `/hub`, which is where the model was downloaded in the first
  place and where the "Installed on this device" filter lists what is on disk —
  yet it offered no way to delete anything. Users reported having no delete
  button at all, because nothing on the screen they think of as "models" has one.
- **Decision:** the Hub's download panel renders a trash button next to
  "New chat" once a variant is installed (`DeleteModelAction`, opt-in via a
  `deletable` prop on `ModelDownloadAction` / `MlxModelDownloadAction`, so the
  onboarding screens keep their single unambiguous action). It confirms, unloads
  the model when it is currently active, calls
  `models().deleteModel(id, provider)`, drops it from favourites and from the
  provider cache, then re-lists the engines. The provider/id pair is resolved
  through `findInstalledLocalModel` in `lib/hub-installed.ts`, the same module
  that decides what the installed filter shows, so the delete target is the id
  the engine actually registered rather than the catalog's spelling of it. The
  panel also opens on the installed quant instead of the recommended one, and
  keeps the action live for an installed quant this device cannot run —
  otherwise the button would sit behind the disclosure, or behind a disabled
  "Download" tooltip, for exactly the models a user most wants to reclaim.
- **Consequences:** deletion now lives where the download happened, with the
  Settings dialog unchanged as the second entry point. `isDownloaded` in
  `ModelDownloadAction` now also matches the developer-prefixed spelling of a
  quant id, aligning it with the installed-filter rules — a model registered
  under `owner/quant-id` no longer shows a "Download" button for a file already
  on disk. `llamacpp` and `llamacpp-upstream` share one models directory, so one
  delete removes the file for both and the refresh drops both rows. Deleting a
  model discovered by the local scan (LM Studio, Ollama, HF cache) removes Jan's
  registration of it; the engine reports an error if its `model.yml` is already
  gone, and that error is surfaced in a toast with the row left untouched.
- **Owner:** `team`
- **Links:** `web-app/src/containers/hub/DeleteModelAction.tsx`,
  `web-app/src/containers/hub/DownloadOptionsSelect.tsx`,
  `web-app/src/containers/ModelDownloadAction.tsx`,
  `web-app/src/containers/MlxModelDownloadAction.tsx`,
  `web-app/src/lib/hub-installed.ts`,
  [2026-08-14 — Build the Hub "Installed on this device" list from the provider registry](2026-08-14-build-the-hub-installed-filter-from-the-provider-registry.md)

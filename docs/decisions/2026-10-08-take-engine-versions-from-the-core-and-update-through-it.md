---
date: 2026-10-08
title: "Take engine versions from the core, and update and switch engine builds only through it"
---

# 2026-10-08 — Take engine versions from the core, and update and switch engine builds only through it

- **Context:** Four producers made engine update offers: each llama.cpp
  extension (`reconcileBackendReleaseTag` → `offerEngineUpdate`), the MLX
  extension and the image store, each with its own copy of
  `engineUpdateOffer.ts` and an `atomic_engine_update_offer_*` key. The
  llama.cpp extensions also applied updates themselves: install through the
  core, write `version_backend` into their settings, unload models, then prune
  old builds with the Rust `remove_old_backend_versions` (on Windows before the
  unload, over a running `llama-server.exe`), with a `*_pending_backend` key to
  finish at the next launch. Picking another build in the version list wrote
  `version_backend` and stopped every model. The core now answers all of this
  (core ADR `2026-10-08-the-core-applies-engine-updates-and-owns-version-backend.md`,
  openspec change `unify-engine-lifecycle`): `POST /engines/versions`,
  `POST /engines/:engine/update`, `POST /engines/:engine/builds/:v/:variant/activate`,
  `DELETE /engines/:engine/builds/:v/:variant`, and `engine:changed`.
- **Decision:** The desktop takes engine versions and offers only from the
  core and changes engine builds only through it.
  - `useEngineVersionsStore` asks `POST /engines/versions` once the core is
    attached and again on `engine:changed`, `environment:changed` and a
    `settings:changed` of `version_backend`; the "Check for updates" buttons
    ask with `force`. One request at a time.
  - The update banner offers exactly what the core marks `update.needed`, in
    the old engine order, with the 24-hour snooze and the per-target dismiss
    kept in `localStorage`; `blocked_reason` is never an offer. "Update" calls
    `POST /engines/:engine/update` (sd.cpp through the image store, which keeps
    Settings → Media's view of it); a managed engine's offer opens its provider
    page, whose card confirms the reinstall (removed and set up again, models
    kept, image size) before calling the core. The legacy offer keys are
    erased at start.
  - Every apply path — the banner, the provider pages, the startup upgrade,
    the setup step, the suboptimal-backend dialog, the Decision and Embedding
    sections, the PrismML install, a TurboQuant first run and a parked
    `latest/` — calls the core's update with a `target`. A `latest/<variant>`
    pick is resolved by the extension (family ids such as `win-cuda-12-x64`
    have no exact build) and sent as `{version, variant}`.
  - Picking an installed build in the version list calls `activate`; the list
    shows the pick, goes back and says why when the core refuses, and only
    clears the GPU `device` after the core switched.
  - The llama.cpp dialog, the provider page and the startup flows keep hearing
    `onBackendDownloadStarted/Finished` and `app:backend-hotswapped`, now sent
    around the core's answer.
  - The extensions follow the `version_backend` the core writes: on
    `settings:changed` the mirror adds the build to the version options before
    writing it, records its type and sends `settingsChanged`; a load waits for
    a mirror in flight and never imports back what the mirror wrote.
  - The provider pages (llama.cpp, MLX) and Settings → Media list the
    installed builds with Remove (asks first; unavailable with the reason for
    the active, bundled and in-use builds) and, where the client picks the
    build, Make active.
  - Removed: the offer producers and their copies, `applyBackendLive`,
    `updateBackend`, `downloadRecommendedBackend` and `downloadManualBackend`
    in the extensions, the pending keys, `activatePendingBackend` and its
    "pending" pill, the extensions' update checks, and the Rust
    `remove_old_backend_versions` command in both plugins.
- **Consequences:** One source of truth for every engine, the same as `atc`
  gets. The desktop never writes `version_backend`, unloads models for a
  switch or removes builds. An update only unloads the models of its own
  provider (the version list used to stop every model). PrismML's offer has no
  release note or link: the core's answer does not carry them. The desktop
  depends on core routes released after core 0.12.1; until the pin moves, it
  runs against a local core. Rollback is the previous app with its pinned core:
  its extensions apply updates themselves, and the settings and builds on disk
  stay compatible.
- **Owner:** `team`.
- **Links:** openspec change `unify-engine-lifecycle` (specs
  `engine-lifecycle`, `engine-lifecycle-desktop`);
  [`web-app/src/stores/engine-versions-store.ts`](../../web-app/src/stores/engine-versions-store.ts),
  [`web-app/src/services/engines/`](../../web-app/src/services/engines/),
  [`web-app/src/hooks/useEngineUpdate.ts`](../../web-app/src/hooks/useEngineUpdate.ts),
  [`web-app/src/containers/engines/InstalledEngineBuilds.tsx`](../../web-app/src/containers/engines/InstalledEngineBuilds.tsx),
  [`extensions/shared/coreEngineUpdate.ts`](../../extensions/shared/coreEngineUpdate.ts),
  [`extensions/shared/atomicCoreSettingsSync.ts`](../../extensions/shared/atomicCoreSettingsSync.ts).

<!--
Supersedes: 2026-07-01-fix-llamacpp-upstream-hot-swap-race-persist-version-backend.md (the desktop no longer applies an update; the core writes version_backend before it unloads)
Refines: 2026-09-14-ask-before-updating-an-inference-engine.md (the offer comes from the core; still asked, never taken)
-->

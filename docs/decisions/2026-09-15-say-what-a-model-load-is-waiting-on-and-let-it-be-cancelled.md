---
date: 2026-09-15
title: "Say what a model load is waiting on, and let it be cancelled"
---

# 2026-09-15 — Say what a model load is waiting on, and let it be cancelled

- **Context:** ATO-530 asked for a loading snackbar with the actual stage
  ("loading from cache and a cold start are different waits"), a Cancel, a
  "loaded" state, and a model dot that unloads in one click. Nothing reported
  a stage: the extensions' `load` was one opaque promise, and llama-server
  prints almost nothing useful at our log level. Nothing could cancel either.
  A llama.cpp or MLX child enters the plugin's session map only once it is
  ready, so `unload` could not find a load in flight. ATO-535 had just added
  a "starting" strip above the composer and asked that the two be one status
  system.

- **Decision:**
  - **Stages.** Each step is reported by whoever runs it.
    - `AIEngine.load` takes an optional `{ onStage }`. The llama.cpp and MLX
      extensions report `installingEngine` when the build is missing, and
      `loadingWeights` right before spawning the server.
    - `loadingWeights` carries how much of the model files the OS already
      has in its page cache. A new core command,
      `get_page_cache_resident_fraction`, measures it with `mincore(2)` on a
      read-only mapping (`jan_utils::page_cache`); ≥ 0.9 reads as "cached".
    - `doSwitchToModel` reports `unloadingPrevious`, the OOM retry rung and
      `startingServer`.
  - **Cancel.**
    - Each engine plugin registers a cancellation token per model id for the
      whole load (`jan_utils::load_cancel`). `cancel_*_model_load` trips it,
      and the load kills its child and returns `MODEL_LOAD_CANCELLED`.
    - `AIEngine.cancelLoad` covers the JS steps before the invoke and retries
      while that invoke is on its way to the plugin. If the server became
      ready first, it unloads it.
    - `cancelModelLoad` in the switch records a user stop, so the model stays
      selected but down (ADR 2026-09-11). The cancelled switch raises no
      toast, telemetry, Sentry event or auto-start backoff.
  - **UI.**
    - The snackbar is a sonner custom toast, top-right, reading
      `useInferenceStatus`. It shows "loaded" for 3 s.
    - The ATO-535 strip now shows only `failed`, so a load in flight is
      announced once.
    - The pill dot is a button next to the picker trigger. Clicking a loaded
      model unloads it; clicking a load in flight cancels it, so closing the
      snackbar never loses the Cancel.
    - An unload needs no confirm: it is a user stop, and the next Send brings
      the model back.

- **Consequences:**
  - **No overlap.** The snackbar stacks with the other top-right toasts.
    The update banners hold the bottom-right corner (ADR 2026-09-14), so
    the two never overlap.
  - **Windows.** There is no page-cache answer on Windows; it shows the
    neutral "Loading the model into memory".
  - **Loads that bypass `switchToModel`** get no snackbar: the lazy start on
    send, `restartLocalModel` after a settings change, and the Local API
    Server's `ensureModelForServer`. They never set `loadingModel` either.
    Move them onto the switch if users ask why those are silent.
  - **Engines that cannot cancel** (foundation-models) finish the load; the
    switch then unloads the model.
  - **Tokens are keyed by model id.** Two concurrent loads of the same id
    share one, which the extensions already de-duplicate.
  - **Dependency.** `jan-utils` now depends on `libc` on Unix. It was already
    in the lockfile and linked into the app.
  - **Extensions.** They call the new plugin commands directly: upstream and
    the fork via their source guest-js, MLX via `invoke`, because its guest
    API ships as a separately built `dist-js`.

- **Owner:** @m-skvortsov

- **Links:** [ATO-530](https://linear.app/atomicchat/issue/ATO-530),
  [ATO-535](https://linear.app/atomicchat/issue/ATO-535),
  `src-tauri/utils/src/load_cancel.rs`, `src-tauri/utils/src/page_cache.rs`,
  `src-tauri/src/core/system/page_cache.rs`,
  `core/src/browser/extensions/engines/AIEngine.ts`,
  `web-app/src/utils/switchModel.ts` (`cancelModelLoad`, `unloadModelByUser`),
  `web-app/src/lib/inference-status.ts`,
  `web-app/src/containers/ModelLoadSnackbar.tsx`,
  `web-app/src/containers/ActiveModelIndicator.tsx`

---
date: 2026-07-29
title: "Mirror the hot-swap persist-before-unload order into the TurboQuant `llamacpp` provider and lock both orders down with tests"
---

# 2026-07-29 — Mirror the hot-swap persist-before-unload order into the TurboQuant `llamacpp` provider and lock both orders down with tests

- **Context:** The [2026-07-01 ADR](2026-07-01-fix-llamacpp-upstream-hot-swap-race-persist-version-backend.md)
  fixed the hot-swap ordering race in `applyBackendLive()` for
  `llamacpp-upstream` only: `updateBackend()` must commit the new
  `version_backend` into `this.config` before any loaded model is unloaded,
  because an unload makes the web app auto-reload the model and
  `performLoad()` snapshots `this.config` synchronously. Mirroring it into the
  TurboQuant provider was explicitly declined at the time on the grounds that
  it was macOS-only. That premise no longer holds — the
  [2026-06-23 ADR](2026-06-23-ship-the-turboquant-llamacpp-provider-on-windows-linux-as-a.md)
  ships TurboQuant on Windows and Linux as a second provider, so its
  byte-identical unload-then-update ordering is exposed to the same race on
  exactly the platform where the bug was reported. Neither provider had a test
  pinning the order, nor any coverage of what a "Find optimal backend" press
  or a version update actually persists — the whole download → hot-swap →
  activate chain was assertion-free.
- **Decision:** Reorder `applyBackendLive()` in
  `extensions/llamacpp-extension/src/index.ts` to match upstream —
  `getLoadedModels()` → `updateBackend()` (throwing before any model is
  touched when `wasUpdated` is false) → unload each previously-loaded model —
  and cover the backend-replacement chain in both providers with tests:
  hot-swap ordering, the pending-marker lifecycle across download and
  hot-swap failures, `activatePendingBackend()`, what `recheckOptimalBackend()`
  recommends and persists, and that a version update keeps the backend type
  while only the version moves.
- **Consequences:** TurboQuant users on Windows/Linux who hot-swap while a
  model is loaded now run on the new backend the moment the UI says so, and a
  failed swap no longer strands them model-less. The ordering is now a tested
  invariant in both providers rather than a comment: reverting either order
  fails `applyBackendLive > persists the new backend before unloading any
  model` (verified by mutation). The two providers keep their intentional
  differences — turboquant resolves the recommended tag from the manifest
  catalog (each variant ships its own release) and treats "already optimal" by
  backend category, upstream compares the exact backend type and appends the
  new dropdown option — so the test suites are parallel, not identical. No
  IPC, Rust, settings-schema or on-disk-layout change.
- **Owner:** team.
- **Links:** [2026-07-01](2026-07-01-fix-llamacpp-upstream-hot-swap-race-persist-version-backend.md)
  (the original reorder), [2026-06-23](2026-06-23-ship-the-turboquant-llamacpp-provider-on-windows-linux-as-a.md)
  (TurboQuant on Windows/Linux, which invalidated the macOS-only premise),
  [2026-06-24](2026-06-24-add-a-find-optimal-backend-button-a-once-ever-post-first-launch.md)
  ("Find optimal backend" flow), files:
  [`extensions/llamacpp-extension/src/index.ts`](extensions/llamacpp-extension/src/index.ts)
  and [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
  (`applyBackendLive`, `downloadRecommendedBackend`, `activatePendingBackend`,
  `recheckOptimalBackend`, `updateBackend`), plus the `backend replacement`
  suites in each provider's `src/test/index.test.ts`.

---

---
date: 2026-08-19
title: "Disable the TurboQuant `llamacpp` provider by default on fresh installs"
---

# 2026-08-19 — Disable the TurboQuant `llamacpp` provider by default on fresh installs

- **Context:** Both local engines ship side-by-side on every desktop platform
  (ADR 2026-06-23): `llamacpp-upstream` (vanilla ggml-org) is the default for
  downloads, onboarding, and auto-start (ADRs 2026-06-09 / 2026-06-15), while
  the TurboQuant `llamacpp` fork registered `active: true` for everyone and
  could still be picked up implicitly: both providers enumerate the same
  shared GGUF directory (`MODELS_PROVIDER_ROOT = 'llamacpp'`), so array-order
  `find()` lookups (post-download auto-switch in `DataProvider`, Hub
  `ModelDownloadAction` fallback, `hub-installed.ts` ordering,
  `ensureModelForServer`), the `getModelToStart` fallback chain, the
  `useThreads` missing-provider default, and the Win/Linux startup
  optimal-backend probe all touched the fork without an explicit user choice.
  The fork also lags upstream on new architectures (`gemma4uv`/`gemma4ua`,
  `lfm2moe`), so a silent landing on it degrades fresh installs.
- **Decision:** Fresh installs register the TurboQuant provider with
  `active: false`; it stays listed under the hidden-providers group in
  Settings → Model Providers and the existing toggle re-enables it fully.
  Existing profiles keep whatever they had. Classification happens once,
  pre-React-mount, in `runTurboquantDefaultMigration()`
  (`web-app/src/lib/turboquantDefaultMigration.ts`): a profile is "existing"
  iff the persisted `model-provider` zustand blob or
  `setup-completed === 'true'` exists; the verdict is frozen in
  `atomic_turboquant_default_active_v1` and consumed by the
  first-registration default in `useModelProvider.setProviders`. Alongside,
  every implicit selection path now skips deactivated providers
  (`active !== false`): `getModelToStart` (all branches), `DataProvider`
  auto-switch, `ModelDownloadAction` fork fallback, `ensureModelForServer`,
  the `alternateLocalBackend` error-toast suggestion, and
  `refreshStartupBackendCaches` (via an `isProviderActive` predicate from
  `StartupBackendCoordinator`); `hub-installed.ts` resolves shared ids
  upstream-first; `useThreads` defaults a missing thread provider to
  `LOCAL_LLAMACPP_PROVIDER`.
- **Consequences:** New users get exactly one visible local engine (upstream)
  and can never land on the fork accidentally; enabling TurboQuant becomes a
  deliberate opt-in with no data migration (shared models dir). Existing
  users see no change — including Windows profiles whose `llamacpp` entry was
  dropped by zustand migration v13: the blob's presence classifies them as
  existing, so the fork re-registers active. Watch for: the migration must
  keep running before the `preloadModelOnStartup` reset in `main.tsx` (that
  `setState` creates the blob and would misclassify a fresh install), and a
  missing flag conservatively falls back to `active: true`.
- **Owner:** team.
- **Links:** `web-app/src/lib/turboquantDefaultMigration.ts`,
  `web-app/src/hooks/useModelProvider.ts` (`setProviders`),
  `web-app/src/utils/getModelToStart.ts`,
  `web-app/src/providers/DataProvider.tsx`,
  `web-app/src/containers/ModelDownloadAction.tsx`,
  `web-app/src/lib/hub-installed.ts`,
  `web-app/src/utils/ensureModelForServer.ts`,
  `web-app/src/utils/switchModel.ts`, `web-app/src/hooks/useThreads.ts`,
  `web-app/src/lib/startupBackendRecommendations.ts`,
  `web-app/src/providers/StartupBackendCoordinator.tsx`; ADRs 2026-06-09,
  2026-06-15, 2026-06-23.

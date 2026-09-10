---
date: 2026-06-24
title: "Add a \"Find optimal backend\" button + a once-ever post-first-launch popup to the TurboQuant `llamacpp` provider on Windows/Linux (clean-id optimal detection, provider-aware `useBackendUpdater`)"
---

# 2026-06-24 — Add a "Find optimal backend" button + a once-ever post-first-launch popup to the TurboQuant `llamacpp` provider on Windows/Linux (clean-id optimal detection, provider-aware `useBackendUpdater`)

- **Context:** The 2026-06-23 ADR shipped the TurboQuant `llamacpp` provider
 on Windows/Linux as a second provider, resolving its backend catalog from
 the `atomic-chat-conf` turboquant manifest with clean ids
 (`windows-x64-cuda-13.3`, `linux-x64-vulkan`, …). But the *optimal-detection*
 path was stale: `detectIdealBackendType`
 ([`extensions/llamacpp-extension/src/index.ts`](extensions/llamacpp-extension/src/index.ts))
 still returned legacy janhq ids (`win-cuda-13-common_cpus-x64`) absent from
 the manifest, so a recommendation pointed at a non-existent asset; the
 web-app `useBackendUpdater`
 ([`web-app/src/hooks/useBackendUpdater.ts`](web-app/src/hooks/useBackendUpdater.ts))
 was hardwired to the upstream extension + the `llama_cpp_*` localStorage
 keys; and the Settings "Find optimal backend" button
 ([`web-app/src/routes/settings/providers/$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx))
 was gated to `provider === LOCAL_LLAMACPP_PROVIDER` (upstream only). So a
 TurboQuant user on Win/Linux booted on the bundled CPU build with no way to
 discover/download a faster GPU backend, and the default-vision out-of-box
 path (request #3, upstream-first) was already correct but unverified.
- **Decision (per the user-chosen options — popup shown `once_ever`, scope
 `win_linux`):**
 1. **Clean-id optimal detection (TurboQuant extension).**
 `detectIdealBackendType` rewritten to pick from `listSupportedBackends()`
 (already manifest-filtered to clean, supported ids) and return the
 upstream-style discriminated `IdealBackendResult` (`gpu` / `cpu-optimal`
 / `detection-failed`) + an exported `BACKEND_DETECTION_FAILED` sentinel:
 Windows prefers `windows-x64-cuda-13.3` (cuda13) → `windows-x64-cuda-12.4`
 (cuda12) → `windows-x64-vulkan` (vulkan + VRAM); Linux → `linux-x64-vulkan`
 (vulkan + VRAM) else cpu-optimal. `recheckOptimalBackend` runs detection
 under `withTimeout`, throws `BACKEND_DETECTION_FAILED` on manifest
 unreachability, returns null on cpu-optimal, and on `gpu` resolves the
 concrete `{ version: tag, backend: id }` straight from the catalog (each
 turboquant entry carries its own tag), persisting + emitting
 `onBetterBackendDetected`. `get_backend_category`/`backendCategoryToLabel`
 updated to recognise the clean ids. Provider-specific localStorage keys
 (`TURBOQUANT_RECOMMENDATION_KEY` / `TURBOQUANT_PENDING_KEY`) replace the
 hardcoded `llama_cpp_*` keys to avoid collision with the upstream
 extension (both ship on Win/Linux).
 2. **Provider-aware `useBackendUpdater`.** New optional
 `UseBackendUpdaterConfig` (`extensionName` / `providerId` /
 `recommendationKey` / `postUpgradeRecheckEnabled`), defaulting to the
 upstream extension + existing keys. `handleBetterBackendDetected` now
 filters events by `providerId` so the turboquant and upstream instances
 of the hook never cross-contaminate. `$providerName.tsx` builds the config
 with `useMemo` keyed on `providerName === 'llamacpp'` and extends the
 button's render gate + `handleFindOptimalBackend` to fire for
 `provider === 'llamacpp'` on `IS_WINDOWS || IS_LINUX`, reusing the
 existing `backendUpdater.*` i18n.
 3. **Once-ever first-launch popup.** New
 [`web-app/src/containers/dialogs/TurboquantOptimalBackendDialog.tsx`](web-app/src/containers/dialogs/TurboquantOptimalBackendDialog.tsx)
 (Skip / Find optimal), mounted globally in
 [`__root.tsx`](web-app/src/routes/__root.tsx) next to `BackendUpdater`
 (gated on `isSetupCompleted`). It drives the whole flow through a
 turboquant-configured `useBackendUpdater`, so detection → download →
 hot-swap → restart-required render off the hook's `recommendationPhase`.
 Trigger: `maybePromptTurboquantOptimal` in
 [`switchModel.ts`](web-app/src/utils/switchModel.ts) dispatches a window
 `TURBOQUANT_OPTIMAL_PROMPT_EVENT` on a successful start where the provider
 is `llamacpp`, on Win/Linux, and the new
 `localStorageKey.turboquantOptimalPromptShown` flag is unset (called on
 both the already-active and full-load success paths). The dialog **sets
 the flag the moment it is shown**, so it is strictly once-ever even if the
 user dismisses with Esc or reloads mid-flow.
 4. **Driver-floor alignment (Part A.4).** `min_cuda13_driver` for Windows
 in [`tauri-plugin-llamacpp/src/backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs)
 raised to the NVIDIA-documented `581.15`, matching the `llamacpp-upstream`
 plugin.
 5. **Default-provider verification (request #3).** Confirmed upstream is
 already the default everywhere (`LOCAL_LLAMACPP_PROVIDER =
 'llamacpp-upstream'`, `getModelToStart` order upstream-first); added the
 missing `'llamacpp-upstream'` arm to the empty-state fallback `find` in
 [`DropdownModelProvider.tsx`](web-app/src/containers/DropdownModelProvider.tsx)
 (previously matched only `llamacpp | mlx`, so a fresh install with models
 only under the upstream provider could fail to auto-select one).
- **Consequences:** TurboQuant users on Windows/Linux now get a one-time
 prompt after their first model start offering to download the fastest
 backend for their hardware (CUDA/Vulkan), plus a persistent
 Settings → Providers "Find optimal backend" button — exactly mirroring the
 upstream provider, but resolving every id/tag from the turboquant manifest.
 "Skip" keeps the current (bundled CPU) backend; the model is already running
 either way. macOS turboquant (single `macos-arm64` backend) is untouched —
 the popup and button are Win/Linux-gated. **Deliberately NOT done:** no
 per-provider tagging of the `app:backend-hotswapped` event (pre-existing;
 both dialog instances receive it, harmless since the global `BackendUpdater`
 has a null turboquant recommendation); no stale-comment sweep beyond the
 `DropdownModelProvider` fallback. **Verified:** web-app `tsc -b` clean;
 `eslint` clean on all 7 touched web-app files; turboquant extension rolldown
 build clean (`dist/index.js` 196.11 kB, exit 0 — the authoritative compile);
 `cargo test --lib backend` 33/33 green in `tauri-plugin-llamacpp`; all reused
 `backendUpdater.*` keys present and the new `turboquantOptimalPrompt.*` block
 added in EN + RU (other locales fall back to EN). Manual Win/Linux
 first-launch smoke test is the remaining step (no such host in the sandbox).
- **Owner:** team.
- **Links:** the 2026-06-23 ADR *Ship the TurboQuant `llamacpp` provider on
 Windows + Linux …* (the manifest + clean-id foundation), the 2026-06-15 ADR
 *Stop "Find optimal backend" from silently degrading to CPU …* (the
 `IdealBackendResult` / `BACKEND_DETECTION_FAILED` contract this mirrors), the
 2026-06-09 ADR *Default the macOS local llama.cpp engine to `llamacpp-upstream`*
 (ATO-116, upstream-first default), files:
 [`extensions/llamacpp-extension/src/index.ts`](extensions/llamacpp-extension/src/index.ts)
 (`detectIdealBackendType`, `recheckOptimalBackend`, `get_backend_category`,
 `TURBOQUANT_RECOMMENDATION_KEY`/`TURBOQUANT_PENDING_KEY`),
 [`web-app/src/hooks/useBackendUpdater.ts`](web-app/src/hooks/useBackendUpdater.ts)
 (`UseBackendUpdaterConfig`, provider-filtered events),
 [`web-app/src/routes/settings/providers/$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx)
 (button gate + `useMemo` config),
 [`web-app/src/containers/dialogs/TurboquantOptimalBackendDialog.tsx`](web-app/src/containers/dialogs/TurboquantOptimalBackendDialog.tsx),
 [`web-app/src/routes/__root.tsx`](web-app/src/routes/__root.tsx),
 [`web-app/src/utils/switchModel.ts`](web-app/src/utils/switchModel.ts)
 (`TURBOQUANT_OPTIMAL_PROMPT_EVENT`, `maybePromptTurboquantOptimal`),
 [`web-app/src/constants/localStorage.ts`](web-app/src/constants/localStorage.ts)
 (`turboquantOptimalPromptShown`),
 [`web-app/src/containers/DropdownModelProvider.tsx`](web-app/src/containers/DropdownModelProvider.tsx)
 (empty-state fallback),
 [`src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs)
 (`min_cuda13_driver`),
 [`web-app/src/locales/en/settings.json`](web-app/src/locales/en/settings.json) +
 [`web-app/src/locales/ru/settings.json`](web-app/src/locales/ru/settings.json)
 (`turboquantOptimalPrompt`).

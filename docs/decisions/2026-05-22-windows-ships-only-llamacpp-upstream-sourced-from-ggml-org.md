---
date: 2026-05-22
title: "Windows ships only `llamacpp-upstream`, sourced from `ggml-org/llama.cpp`"
---

# 2026-05-22 — Windows ships only `llamacpp-upstream`, sourced from `ggml-org/llama.cpp`

- **Context:** After the 2026-05-19 ADR *Ship upstream `ggml-org/llama.cpp`
  as a second macOS provider*, Windows ended up exposing **two** llama.cpp
  providers with effectively identical UI titles — the turboquant
  `llamacpp` extension (driven by `extensions/llamacpp-extension/` against
  `janhq/llama.cpp` Windows binaries that lack our TurboQuant kernels — see
  the 2026-05-19 ADR *Windows uses upstream `ggml-org/llama.cpp`, not the
  TurboQuant fork*) and the parallel `llamacpp-upstream` extension
  (driven by `extensions/llamacpp-upstream-extension/` against ggml-org
  directly on macOS). Because the turboquant features TurboQuant KV cache,
  TurboQuant weights, Gemma 4 MTP, Qwen 3.6 NextN are explicitly disabled
  on Windows anyway, the two providers were functionally equivalent on
  Windows — just two onboarding paths, two settings pages, two model lists,
  two backend folders on disk, two best-backend buttons. Users got
  confused. Internally we maintained two near-identical Windows code
  paths, two CI download steps, and two Tauri plugin registrations.
- **Decision:** On **Windows x64** only the `llamacpp-upstream` provider
  ships and the entire user-facing surface (onboarding, best-backend
  detection, settings, model imports) is routed through
  `llamacpp-upstream-extension` + `tauri-plugin-llamacpp-upstream`. The
  upstream extension is the **sole** source of Windows backend binaries
  (downloaded from `ggml-org/llama.cpp` releases as `.zip` archives) and
  the bundled offline fallback (`win-cpu-x64`) is shipped under
  `src-tauri/resources/llamacpp-backend-upstream/`. macOS keeps both
  providers per the 2026-05-19 ADR. Linux keeps `llamacpp` as the sole
  primary.
- **Consequences:**
  - **Build artefacts:**
    - `package.json :: build:extensions:win32` excludes
      `@janhq/llamacpp-extension` so the Windows `pre-install/` folder
      only carries `janhq-llamacpp-upstream-extension-*.tgz`.
    - `src-tauri/tauri.windows.conf.json` bundle resources include
      `resources/llamacpp-backend-upstream/**/*` and NOT
      `resources/llamacpp-backend/**/*`.
    - The `tauri-plugin-llamacpp` Rust crate is still registered on
      Windows because `src-tauri/src/core/server/proxy.rs` threads its
      `LlamacppState` type through ~16 routing sites. The plugin is
      effectively **dead code** on Windows — no extension drives it,
      no resource dir feeds it, no settings UI exposes it. The proxy's
      built-in "try turboquant pool → fall back to upstream pool →
      fall back to MLX" routing transparently handles any stray call.
      A future ADR may cfg-gate the type itself.
  - **Windows backend naming changes (NOT compatible with the legacy
    janhq matrix):** the supported variants are
    `win-cpu-x64`, `win-cuda-12.4-x64`, `win-cuda-13.1-x64`,
    `win-vulkan-x64`. There is **no CUDA 11 build** on Windows anymore
    (ggml-org dropped it; hosts whose NVIDIA driver only supports CUDA
    11 fall back to the CPU build). Driver thresholds are now
    `>= 551.61` for CUDA 12.4 and `>= 581` for CUDA 13.1, matching the
    ggml-org release notes. Legacy names like
    `win-cuda-12-common_cpus-x64` are mapped to the closest new variant
    by `map_old_backend_to_new` in
    `tauri-plugin-llamacpp-upstream/src/backend.rs`.
  - **On-disk layout:** the active backends directory on Windows
    becomes `<data>\llamacpp-upstream\backends\`. The legacy
    `<data>\llamacpp\backends\` from prior installs is intentionally
    left **orphaned** — there is no migration script. Onboarding's
    `SetupBackendStep` runs again on first launch (its
    `llamacpp_onboarding_done` localStorage flag stays per-provider on
    completion, not on identity) and auto-downloads the optimal
    upstream backend. If GPU detection or download fails, the bundled
    `win-cpu-x64` build serves as the always-available offline
    fallback.
  - **Models stay shared.** `MODELS_PROVIDER_ROOT = 'llamacpp'` in both
    extensions, so all GGUFs continue to live under
    `<data>\llamacpp\models\` regardless of which provider downloaded
    them. No model migration is needed; macOS users that switch
    between providers see the same model list on both.
  - **cudart DLLs source.** `ggml-org` publishes companion
    `cudart-llama-bin-win-cuda-12.4-x64.zip` /
    `cudart-llama-bin-win-cuda-13.1-x64.zip` archives on every release,
    so the cudart helper (`scripts/download-llamacpp-cudart-windows.ps1`
    and the runtime `ensureCudartReady` in
    `llamacpp-upstream-extension/src/index.ts`) pulls from ggml-org —
    not from `janhq/llama.cpp` like before. The companion archives are
    `.zip`, so the helper uses `Expand-Archive` instead of `tar -xzf`.
  - **UI shows a single provider on Windows.** The Settings →
    Providers list contains exactly one "Llama.cpp" entry, the
    onboarding `SetupBackendStep` and the Settings → Providers
    "Find optimal backend" button both target the upstream provider,
    and `getProviderTitle('llamacpp')` no longer returns "Llama.cpp"
    because that provider is not registered on Windows. The Windows
    arm of the provider id is centralized as
    `LOCAL_LLAMACPP_PROVIDER` / `LOCAL_LLAMACPP_EXTENSION_NAME` in
    `web-app/src/lib/utils.ts` so individual call sites don't fork
    per OS.
  - **CI / dev scripts:** `Makefile :: download-llamacpp-backend` is
    a no-op on Windows; the Windows branch of
    `download-llamacpp-upstream-backend` now does GPU detection and
    pulls the optimal ggml-org backend into the upstream resource dir,
    with `download-llamacpp-backend-win-cpu` kept as a deprecated
    alias delegating to `download-llamacpp-upstream-backend-win-cpu`.
    `scripts/dev-windows.ps1`, `scripts/build-windows-release.ps1`,
    and `.github/workflows/release.yml` (Windows job) all target
    `ggml-org/llama.cpp` and the upstream resource dir.
  - **macOS / Linux unchanged.** No code path on macOS or Linux is
    touched by this ADR. Linux still ships only the turboquant
    `llamacpp` provider; macOS still ships both per the 2026-05-19
    dual-provider ADR.
- **Owner:** team.
- **Links:** §4.2 *LLM backend*, the 2026-05-19 ADRs *Ship upstream
  `ggml-org/llama.cpp` as a second macOS provider* and *Windows uses
  upstream `ggml-org/llama.cpp`*, the 2026-05-22 ADR *Ship cudart DLLs
  with every Windows CUDA backend*, `extensions/llamacpp-upstream-extension/`,
  `src-tauri/plugins/tauri-plugin-llamacpp-upstream/`,
  `src-tauri/tauri.windows.conf.json`, `Makefile`,
  `scripts/dev-windows.ps1`, `scripts/build-windows-release.ps1`,
  `scripts/download-llamacpp-cudart-windows.ps1`,
  `web-app/src/lib/utils.ts`,
  `web-app/src/hooks/useBackendUpdater.ts`,
  `web-app/src/containers/SetupBackendStep.tsx`,
  `web-app/src/containers/SetupScreen.tsx`,
  `web-app/src/routes/settings/providers/$providerName.tsx`.

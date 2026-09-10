---
date: 2026-06-08
title: "Windows: fix clean-install config persistence (ATO-107), de-hardcode the CUDA-13 minor (ATO-105), and harden onboarding hardware detection against hangs (ATO-104)"
---

# 2026-06-08 — Windows: fix clean-install config persistence (ATO-107), de-hardcode the CUDA-13 minor (ATO-105), and harden onboarding hardware detection against hangs (ATO-104)

- **Context:** Three related Windows bugs from a single Discord report
  (TechnicallyBen, RTX Quadro 6000, driver 596.59, 1.1.103, clean install):
  - **[ATO-107](https://linear.app/atomicchat/issue/ATO-107) (Urgent, confirmed
    by code + logs):** on a clean install `settings.json` was never written —
    50+ repeats of `App config not found … Failed to create default config: The
    system cannot find the path specified. (os error 3)`. Root cause: the config
    path is `app_data_dir()` = `…\Roaming\chat.atomic.app`, which does not exist
    yet on a fresh install, and both writers
    ([`get_app_configurations`](src-tauri/src/core/app/commands.rs) and
    [`update_app_configuration`](src-tauri/src/core/app/commands.rs)) called
    `fs::write` **without** `create_dir_all` on the parent (the CLI path
    `resolve_config_file_path` already did). Nothing persisted (backend choice,
    onboarding completion, data_folder), and `Failed to add server config / MCP
    config` cascaded from the same cause.
  - **[ATO-105](https://linear.app/atomicchat/issue/ATO-105) (Medium, latent):**
    [`determine_supported_backends`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs)
    hardcoded `win-cuda-13.3-x64` while the rest of the Windows path was already
    dynamic (`fetchRemoteBackends` whitelist `^win-cuda-13\.\d+-x64$`,
    `get_backend_category`, cudart resolve). It only matched the live ggml-org
    asset (`b9553` → `win-cuda-13.3-x64`) by accident; the next CUDA-13 minor
    bump would silently drop CUDA for all Windows users (CPU fallback / 404).
  - **[ATO-104](https://linear.app/atomicchat/issue/ATO-104) (High, not yet
    root-caused to one commit):** clean-install onboarding hung on "Detecting
    your hardware". Suspected mechanism is the ATO-107 config-persistence failure
    plus an unbounded detection await; the ticket still wants user logs + a
    release bisect (1.1.99–1.1.102) to nail the exact regressor.
- **Decision:** One combined Windows fix set. ATO-104 is handled by *defensive
  hardening* now (per maintainer direction), deferring the deep root-cause to
  logs/bisect.
  1. **ATO-107:** create the parent dir before every config write. Added
     `if let Some(parent) = configuration_file.parent() { fs::create_dir_all(parent) }`
     ahead of `fs::write` in both `get_app_configurations` (log-and-continue on
     error, matching its existing non-fatal style) and `update_app_configuration`
     (propagates the error via `?`).
  2. **ATO-105:** make CUDA-13 a *family*, never a hardcoded minor.
     `determine_supported_backends` now pushes the minor-less id
     **`win-cuda-13-x64`** when `features.cuda13`. The TS filter in
     [`listSupportedBackends`](extensions/llamacpp-upstream-extension/src/backend.ts)
     accepts any concrete `win-cuda-13.<minor>-x64` remote asset when the family
     `win-cuda-13-x64` is in the supported set (regex `^win-cuda-13\.\d+-(x64|arm64)$`),
     and keeps passing the **concrete** id downstream so the correct asset is
     downloaded. `map_old_backend_to_new` gained a pass-through so the new family
     id round-trips unchanged; the legacy `cuda-13.x → 13.3` folding (migration of
     persisted ids only, backstopped by `resolveLatestBackendString`) is left as-is.
  3. **ATO-104:** guarantee onboarding detection terminates. In the extension,
     `recheckOptimalBackend` now wraps `detectIdealBackendType()`,
     `listSupportedBackends()`, and `resolveLatestBackendString()` in the existing
     `withTimeout` (20s each → `null`/`[]` on timeout, i.e. "no GPU recommendation"
     → CPU fallback) instead of awaiting unbounded. In the UI,
     [`SetupBackendStep`](web-app/src/containers/SetupBackendStep.tsx) gained a 30s
     watchdog that flips a still-`detecting` step to `detection-failed`
     (auto-advances to the model step), so the user is never trapped on the spinner.
     The `get_devices` probe is already bounded (30s, `device.rs`) and isn't even
     invoked on a clean install (CUDA tier not installed yet); the ATO-95
     hard-throw on an unresolved `latest` sentinel is already guarded and untouched.
- **Consequences:**
  - Clean Windows installs persist config on first launch (ATO-107). CUDA-13
    survives future ggml-org minor bumps with no source edits (ATO-105).
    Onboarding can no longer hang indefinitely on detection; worst case it
    degrades to CPU and the user proceeds (ATO-104).
  - **Deferred (non-code):** the exact 1.1.98→1.1.103 regressor for ATO-104 still
    needs the user's `Settings → Logs` capture and a per-release bisect. The
    hardening makes the symptom non-fatal but does not, by itself, prove the
    original cause.
  - **Verification:** `cargo check -p Atomic-Chat` and the upstream plugin both
    compile (0 errors, pre-existing dead_code warnings only); `cargo test` in
    `tauri-plugin-llamacpp-upstream` → 37 backend tests pass (incl. new
    `test_determine_supported_backends_windows_cuda13_family_id` and the
    `win-cuda-13-x64` map round-trip). `tsc --noEmit` clean on the upstream
    extension; eslint clean on `SetupBackendStep.tsx`. macOS/Linux paths
    untouched; no settings-schema, IPC, or on-disk-layout changes.
- **Owner:** team.
- **Links:** [ATO-107](https://linear.app/atomicchat/issue/ATO-107),
  [ATO-105](https://linear.app/atomicchat/issue/ATO-105),
  [ATO-104](https://linear.app/atomicchat/issue/ATO-104), the 2026-05-26 ADR
  *Correct CUDA 13.1 driver gate …* and the 2026-06-05 ADRs *Resolve the
  `latest/<backend>` sentinel …* / *Make the Windows release backend download
  asset-aware …*, §4.2 *LLM backend*, files:
  [`src-tauri/src/core/app/commands.rs`](src-tauri/src/core/app/commands.rs)
  (`get_app_configurations`, `update_app_configuration`),
  [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs)
  (`determine_supported_backends`, `map_old_backend_to_new`),
  [`extensions/llamacpp-upstream-extension/src/backend.ts`](extensions/llamacpp-upstream-extension/src/backend.ts)
  (`listSupportedBackends`),
  [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
  (`recheckOptimalBackend`),
  [`web-app/src/containers/SetupBackendStep.tsx`](web-app/src/containers/SetupBackendStep.tsx).

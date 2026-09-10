---
date: 2026-07-10
title: "Probe `llamacpp-upstream` DFlash support and reject mislabeled bundled binaries"
---

# 2026-07-10 — Probe `llamacpp-upstream` DFlash support and reject mislabeled bundled binaries

- **Context:** A user enabled DFlash on
  `unsloth/Qwen3_5-9B-GGUF-Qwen3_5-9B-IQ4_XS` with upstream backend
  `b9937/macos-arm64`. The DFlash draft resolved, but the selected binary rejected
  `--spec-type draft-dflash` with `unknown speculative type: draft-dflash`;
  its help output listed only `none,draft-simple,draft-eagle3,draft-mtp,...`.
  Direct inspection proved the directory label was false: `llama-server
  --version` reported build `9222 (9a532ae4b)`, while the genuine official
  `b9937` binary reports build `9937` and advertises `draft-dflash`. The macOS
  Make target wrote the new `version.txt` before extracting into a resource
  directory that still contained the old `build/bin`; because that destination
  already existed, relocation of the newly-extracted archive was skipped.
- **Decision:** Keep the model-level DFlash registry in place, but make backend
  support dynamic instead of hard-coded. The upstream Rust plugin now exposes
  `check_spec_type_support(backend_path, spec_type, envs)`, which runs the
  selected `llama-server -h` with the same CUDA/library-path setup used by
  other backend probes and checks whether the help text advertises
  `draft-dflash`. The guest-js layer exposes `checkSpecTypeSupport`, and the
  TS extension uses it both in `checkDflashBackendSupport()` (Settings toggle)
  and in `performLoad()` before calling `loadLlamaModel`. The probe result is
  passed to Rust as `LlamacppConfig.dflash_spec_supported`; the arg builder
  emits `--model-draft ... --spec-type draft-dflash` only when both
  `dflash=true` and `dflash_spec_supported=true`. The serde default stays
  `false`, so stale configs and older extension bundles cannot crash older
  binaries. The macOS download target now clears the resource directory before
  extracting a release. `install_bundled_backend` independently runs
  `llama-server --version`: it refuses a bundled resource whose executable does
  not match `version.txt`, and replaces an existing installed directory when
  its executable is mislabeled.
- **Consequences:** Existing users with `dflash: true` no longer crash on model
  load when the selected backend genuinely lacks DFlash. Correct `b9937`
  resources advertise and enable DFlash, while mislabeled resources can no
  longer masquerade as an updated backend. The local resource was rebuilt and
  verified as `version: 9937 (2021515a1)` with `draft-dflash` present in
  `--spec-type`. Additive IPC only; no settings-schema change.
- **Owner:** team.
- **Links:** files:
  [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
  (`checkDflashBackendSupport`, `backendSupportsDflashSpec`, load-time probe),
  [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs)
  (`dflash_spec_supported`, conditional `add_dflash_args`),
  [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/commands.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/commands.rs)
  (`check_spec_type_support`),
  [`web-app/src/routes/settings/providers/$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx)
  (`handleToggleLlamacppDflash` backend-support toast),
  [`extensions/llamacpp-upstream-extension/src/dflashRegistry.ts`](extensions/llamacpp-upstream-extension/src/dflashRegistry.ts)
  (model-level registry),
  [`Makefile`](Makefile) (clean macOS resource extraction),
  [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs)
  (bundled/installed executable version validation and repair).

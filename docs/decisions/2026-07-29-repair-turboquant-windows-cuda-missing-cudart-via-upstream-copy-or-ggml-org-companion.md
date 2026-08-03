---
date: 2026-07-29
title: "Repair TurboQuant Windows CUDA backends missing cudart by copying from an installed upstream CUDA bin or downloading the ggml-org companion"
---

# 2026-07-29 — Repair TurboQuant Windows CUDA backends missing cudart by copying from an installed upstream CUDA bin or downloading the ggml-org companion

- **Context:** ADR 2026-06-23 assumed TurboQuant Windows CUDA zips ship
  `cudart64` / `cublas64` / `cublasLt64` inline. Release tags inspected on
  2026-07-29 (`69e91e7` and manifest-current `61ee3eb`) omit those DLLs:
  `ggml-cuda.dll` fails to load (WinError 126), llama.cpp prints
  `no usable GPU found` and silently runs on CPU (~10 tok/s) while the UI
  still shows the CUDA tier. Upstream `llamacpp-upstream` already downloads
  `cudart-llama-bin-win-cuda-{12.4,13.3}-x64.zip` from `ggml-org/llama.cpp`
  into its own `build/bin`. The mismatch classifier also treated an empty
  runtime-device snapshot (`backends=[]`, no offload lines) as `ok`, so the
  UI never warned.
- **Decision:**
  1. On TurboQuant Windows CUDA install / `ensureBackendReady`, probe
     `is_cuda_installed`. If false: **copy** matching `cudart*` / `cublas*`
     DLLs from a local `llamacpp-upstream/.../win-cuda-{minor}-x64/build/bin`
     (new Rust `copy_backend_dlls`, never `mv`); if no donor, **download**
     the same ggml-org companion the upstream provider uses (pinned tag
     `b9937`) and merge into the TQ `build/bin`.
  2. Treat `device_init_error` or `cuda_runtime_missing` on a configured GPU
     tier as `runtime-cpu` in `classifyBackendMismatch`, even when
     `primary_device` is empty.
- **Consequences:** Users with an already-downloaded upstream CUDA backend
  get a zero-network repair; others pull the ~cudart companion once. TQ
  release packaging should still be fixed separately so new zips ship
  cudart inline — the app path is a safety net, not a license to keep
  publishing incomplete archives. Forge re-publish of
  `atomic-llama-cpp-turboquant` + manifest bump remains out of this change.
- **Owner:** team.
- **Links:** `extensions/llamacpp-extension/src/backend.ts`,
  `extensions/llamacpp-extension/src/index.ts` (`ensureCudartReady`),
  `extensions/llamacpp-extension/src/util.ts`,
  `src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs` (`copy_backend_dlls`),
  ADR 2026-06-23 (TQ Windows/Linux ship), ADR 2026-05-22 (ship cudart with
  every Windows CUDA backend).

<!--
Supersedes: (none — extends 2026-06-23 with a repair path when inline cudart is absent)
-->

---
date: 2026-05-22
title: "Ship `janhq/llama.cpp` cudart DLLs with every Windows CUDA backend"
---

# 2026-05-22 — Ship `janhq/llama.cpp` cudart DLLs with every Windows CUDA backend

- **Context:** On Windows, `llama-server.exe --list-devices` from a freshly
  installed `win-cuda-{11,12,13}-common_cpus-x64` backend returned an empty
  device list, so GPU detection failed even on machines with a working
  NVIDIA driver
  ([GitHub issue #14](https://github.com/AtomicBot-ai/Atomic-Chat/issues/14)).
  Root cause: the `llama-{tag}-bin-win-cuda-*-common_cpus-x64.tar.gz` archive
  the app downloads ships `llama-server.exe` and direct deps only; the CUDA
  Toolkit runtime DLLs (`cudart64_*.dll`, `cublas64_*.dll`,
  `cublasLt64_*.dll`, …) live in a sibling
  `cudart-llama-bin-win-cu{X.Y}-x64.tar.gz` on the same `janhq/llama.cpp`
  release. Without those DLLs, llama-server's CUDA backend loader silently
  fails on hosts that don't have the CUDA Toolkit installed system-wide.
- **Decision:** Always merge the matching cudart DLLs into
  `<backendDir>/build/bin/` immediately after the main backend archive is
  extracted. Source is the **same** `janhq/llama.cpp` release as the main
  tarball — never `ggml-org`. Hard-coded mapping:
  - `win-cuda-11-common_cpus-x64` → `cudart-llama-bin-win-cu11.7-x64.tar.gz`
  - `win-cuda-12-common_cpus-x64` → `cudart-llama-bin-win-cu12.0-x64.tar.gz`
  - `win-cuda-13-common_cpus-x64` → `cudart-llama-bin-win-cu13.0-x64.tar.gz`

  Implemented at **two layers**, both idempotent:
  1. **Runtime** in `extensions/llamacpp-extension/`:
     - `getCudartDownloadUrl` / `getCudartArchiveName` / `getCudaToolkitVersion`
       helpers in `backend.ts`.
     - `ensureCudartReady` private method in `index.ts` that downloads
       through `@janhq/download-extension` (so the standard download UI
       tracks progress), extracts to a temp dir, and copies every `*.dll`
       into `build/bin/`. Probes `plugin:llamacpp|is_cuda_installed` first
       and is a no-op when DLLs are already present.
     - Wired into `downloadAndInstallBackend` (after main extract) and
       `ensureBackendReady` (pre-flight for users already on `b8892`
       without DLLs — they get the DLLs without re-downloading the 300 MB
       main tarball).
  2. **Build time** in `scripts/download-llamacpp-cudart-windows.ps1`
     (small reusable PowerShell helper), called from:
     - `Makefile :: download-llamacpp-backend` (Windows branch).
     - `scripts/dev-windows.ps1` after the main backend extract.
- **Consequences:**
  - GPU enumeration works out of the box on Windows for the CUDA-11/12/13
    backends, whether the backend was bundled in the installer
    (`make build-windows-release` with a CUDA backend env-var) or downloaded
    at runtime from janhq.
  - Already-installed users (e.g. the issue #14 reporter on `b8892`) are
    fixed on next backend interaction without forcing a full re-download.
  - +50–110 MB on disk per CUDA variant (per-user, after extract).
  - No new external host, no new dependency. Still no change to CI's
    bundled backend choice (Windows CI still ships CPU-only by default);
    the helper is available the moment CI flips to a CUDA bundle.
- **Owner:** team.
- **Links:** [GitHub issue #14](https://github.com/AtomicBot-ai/Atomic-Chat/issues/14),
  `extensions/llamacpp-extension/src/backend.ts`,
  `extensions/llamacpp-extension/src/index.ts`,
  `scripts/download-llamacpp-cudart-windows.ps1`,
  `Makefile` (`download-llamacpp-backend` Windows branch),
  `scripts/dev-windows.ps1`.

---
date: 2026-07-27
title: "Run Windows GAIA evaluation on the selected upstream GPU backend"
---

# 2026-07-27 — Run Windows GAIA evaluation on the selected upstream GPU backend

- **Context:** `make gaia-eval` inherited the macOS-oriented TurboQuant
  `llama-server` path on every platform. On Windows this omitted `.exe` and
  selected the bundled TurboQuant CPU fallback even when development setup had
  already installed the hardware-selected upstream backend, such as
  `win-cuda-13.3-x64`.
- **Decision:** Default `GAIA_LLAMA_SERVER` on Windows to the prepared
  `llamacpp-backend-upstream/build/bin/llama-server.exe`. Preserve the existing
  TurboQuant default on other platforms and preserve an explicit
  `GAIA_LLAMA_SERVER` override everywhere.
- **Consequences:** Windows GAIA runs use the same CUDA 13, CUDA 12, Vulkan, or
  CPU upstream binary selected by the existing Windows backend setup instead
  of silently benchmarking the TurboQuant CPU fallback. GAIA does not download
  or replace backends itself; the selected resource must already exist.
- **Owner:** team.
- **Links:** [`Makefile`](Makefile) (`GAIA_LLAMA_SERVER`, `gaia-eval`),
  [`scripts/dev-windows.ps1`](scripts/dev-windows.ps1).

---
date: 2026-07-28
title: "Ship dual llama providers on Windows and Linux"
---

# 2026-07-28 — Ship dual llama providers on Windows and Linux

- **Context:** Release workflows, extension packaging, and Tauri resource
  manifests already ship both `llamacpp-upstream` and the optional TurboQuant
  `llamacpp` provider on Windows and Linux. Standing agent guidance still
  described those platforms as upstream-only, creating unsafe assumptions in
  backend tests and UI guards.
- **Decision:** Windows and Linux ship both llama.cpp providers, while
  `llamacpp-upstream` remains the default. Fork-only cache types are guarded by
  provider identity on every OS; Linux exposes Vulkan as its only GPU path.
- **Consequences:** Packaging and documentation now describe the same product.
  Each provider retains separate backend ids, assets, driver gates, storage,
  and compatibility pins. Windows/Linux TurboQuant artifact updates require
  platform-specific compatibility verification before a tag is promoted.
- **Owner:** team
- **Links:** `AGENTS.md`, `.github/workflows/release.yml`, `Makefile`,
  `src-tauri/tauri.windows.conf.json`, `src-tauri/tauri.linux.conf.json`

<!--
Supersedes: 2026-05-19-windows-uses-upstream-ggml-org-llama-cpp-not-the-turboquant-fork.md
Supersedes: 2026-05-22-windows-ships-only-llamacpp-upstream-sourced-from-ggml-org.md
Supersedes: 2026-05-28-linux-ships-only-llamacpp-upstream-appimage-upstream-ggml-org.md
-->

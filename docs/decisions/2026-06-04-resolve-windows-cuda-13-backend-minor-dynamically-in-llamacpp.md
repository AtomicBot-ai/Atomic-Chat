---
date: 2026-06-04
title: "Resolve Windows CUDA-13 backend minor dynamically in `llamacpp-upstream`"
---

# 2026-06-04 — Resolve Windows CUDA-13 backend minor dynamically in `llamacpp-upstream`

- **Context:** `ggml-org/llama.cpp` periodically renames Windows CUDA-13 assets by toolkit minor (`13.1` → `13.3` → future `13.x`). Hardcoded ids in `llamacpp-upstream` caused "Failed to download GPU backend" 404 when recommendation/config emitted a stale `win-cuda-13.<old>-x64`.
- **Decision:**
  - In `extensions/llamacpp-upstream-extension/src/backend.ts`, treat Windows CUDA-13 as a family (`win-cuda-13.\d+-x64`) when parsing release assets and derive cudart archive/toolkit version directly from the resolved backend id instead of a fixed `13.3` map.
  - In `extensions/llamacpp-upstream-extension/src/index.ts`, make `detectIdealBackendType()` pick CUDA-13 from the current `listSupportedBackends()` result (actual published asset) instead of emitting a literal backend id.
  - In `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`, generalize CUDA category matching (`cuda-13.*`) and make `is_cuda_installed` resolve runtime DLL names by CUDA **major** (11/12/13), so new 13.x minors do not break the cudart presence probe.
- **Consequences:** Recommendation/download flow now tracks whichever CUDA-13 minor ggml-org currently publishes without source edits for each minor bump; legacy `13.1`/`13.3` installs remain resolvable through existing migration/category logic.
- **Owner:** team.
- **Links:** [Issue #43](https://github.com/AtomicBot-ai/Atomic-Chat/issues/43), [ggml-org/llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases), files: `extensions/llamacpp-upstream-extension/src/backend.ts`, `extensions/llamacpp-upstream-extension/src/index.ts`, `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`.

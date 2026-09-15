---
date: 2026-09-14
title: "One GPU VRAM floor for every OS"
---

# 2026-09-14 — One GPU VRAM floor for every OS

- **Context:** `detectIdealBackendType` gated the Windows ROCm and Vulkan tiers
  on `total_memory >= 6 * 1024` MiB, inline, in two places. ATO-464 had already
  concluded that bar was wrong and lowered Linux to
  `LINUX_VULKAN_MIN_VRAM_MIB = 2 * 1024`, but left Windows untouched. The CUDA
  tiers carry no VRAM gate at all, so the floor was effectively AMD/Intel-only:
  a 4 GB Radeon was told "CPU is optimal" and the verdict cached for 24 h, while
  a 4 GB GeForce on the same code path got CUDA. Users reported the result as
  "all cores pegged, GPU idle, and nothing in the app says why".
- **Decision:** rename the constant to `GPU_BACKEND_MIN_VRAM_MIB` and apply the
  same 2 GiB floor on every OS, at both sites (`determineBestBackend`, which
  feeds the Rust `prioritize_backends` flag, and the Windows tier ladder). The
  ATO-464 reasoning — Vulkan is a third of CUDA's throughput and far more than
  the CPU fallback — is a property of the backend, not of the OS.
- **Consequences:** small discrete AMD/Intel cards on Windows are now offered a
  GPU tier instead of being classified as CPU-optimal. Deliberately *not*
  extended to symmetry: no VRAM floor was added to the CUDA tiers, which would
  be an evidence-free regression. The ROCm archive is ~980 MB, so a small card
  in the PCI table now downloads it; the table is discrete-only, which bounds
  that. `integratedGpuOnly` still keeps iGPU-only hosts on CPU.
- **Owner:** `team`
- **Links:** `extensions/llamacpp-upstream-extension/src/index.ts`,
  `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`,
  `extensions/llamacpp-upstream-extension/src/test/index.test.ts`. Generalises
  ATO-464 (commit `79931903f`, "get Linux hosts onto the Vulkan build they
  already qualify for") from Linux to every OS.

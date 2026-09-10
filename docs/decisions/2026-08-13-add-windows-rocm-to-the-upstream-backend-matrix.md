---
date: 2026-08-13
title: 'Add Windows ROCm to the upstream backend matrix'
---

# 2026-08-13 — Add Windows ROCm to the upstream backend matrix

- **Context:** `ggml-org/llama.cpp` publishes
  `llama-<tag>-bin-win-rocm-7.14-x64.zip` (196.6 MB) built for
  `gfx1010`–`gfx1036` and `gfx1100`–`gfx1201`, i.e. RDNA1 through RDNA4. The
  `llamacpp-upstream` plugin had no notion of ROCm at all, so every AMD Windows
  host went to Vulkan regardless of card. The TurboQuant plugin already carries
  ROCm policy, but its Linux gate reads `gfx_target_version` out of
  `/sys/class/kfd`, which does not exist on Windows. Upstream publishes no Linux
  ROCm or CUDA asset, so this is a Windows-only addition — the Linux upstream
  matrix stays Vulkan-or-CPU and needs no change.
- **Decision:** Windows gains a `win-rocm-x64` backend id, gated in two stages.
  Ahead of launch the only usable signal is the PCI device id, which
  `tauri-plugin-hardware` already reports in `vulkan_info.device_id`:
  `rocm_supported_windows(has_amd_gpu, device_ids)` stays pure and looks the ids
  up in a generated table. `--list-devices` remains the second, empirical gate
  in `tierEnumeratesDevices()`, the same one CUDA uses. `prioritize_backends`
  ranks ROCm between CUDA 11.7 and Vulkan when there is enough VRAM, and drops it
  to the tail with Vulkan when there is not; CUDA and ROCm never compete on the
  same host, so their relative order is irrelevant.

  The id carries no minor version, exactly like `win-cuda-13-x64` from ATO-174 —
  `7.14` will move the way CUDA minors move. The family id resolves to the
  concrete `win-rocm-7.14-x64` from the manifest, which is why
  `resolveCudaFamilyConcrete` was generalized into `resolveGpuFamilyConcrete`.

  No HIP SDK detector is needed: the HIP runtime is linked into `ggml-hip.dll`
  (924 MB unpacked), so an AMD driver is the only host requirement. That size is
  also why ROCm is excluded from the silent startup tier upgrade and why
  `requiredDiskSpaceForBackend` + `available_disk_space` refuse the download when
  the filesystem cannot hold the ~980 MB unpacked result plus headroom.
- **Consequences:**
  - ROCm is the heaviest artefact in the product: ~980 MB on disk against
    34.6 MB for Vulkan. Both gates matter — an RDNA1/RDNA2 owner may get less out
    of it than the space costs, and a card that fails either gate stays on Vulkan
    with no user-visible failure.
  - The PCI table is generated (`make gen-amd-rocm-pci-ids`) from AMD's HIP SDK
    for Windows system-requirements page matched against `pci.ids`, intersected
    with the `AMDGPU_TARGETS` of upstream's `windows-rocm` job. Cards AMD marks
    unsupported are dropped on purpose. Widening the set is a regeneration, not
    an edit; `--check` fails when the committed file is stale. Mesa's
    `amdgpu_pci_ids.h`, the obvious source, does not enumerate RDNA3/RDNA4 device
    ids and could not be used.
  - Gating on a marketing-name match means a card AMD ships after the table was
    generated silently falls back to Vulkan. That is the safe direction: the
    alternative is handing someone a build with no code for their gfx target,
    which aborts on load.
  - `AGENTS.md` §3 no longer claims upstream Windows GPU support is CUDA and
    Vulkan only.
  - `LINUX_UPSTREAM_ASSET_BY_BACKEND` is untouched: on Windows the asset name
    already matches the backend id.
- **Owner:** team
- **Links:** `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`,
  `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/amd_rocm_pci_ids.rs`,
  `scripts/gen-amd-rocm-pci-ids.mjs`,
  `extensions/llamacpp-upstream-extension/src/backend.ts`,
  `extensions/llamacpp-upstream-extension/src/index.ts`,
  `tests/fixtures/hardware/profiles.json`, `tests/hardware-profiles.test.mjs`,
  `docs/decisions/2026-07-31-adopt-unified-turboquant-releases-and-expand-linux-backends.md`,
  `docs/decisions/2026-06-15-stop-find-optimal-backend-from-silently-degrading-to-cpu-when.md`

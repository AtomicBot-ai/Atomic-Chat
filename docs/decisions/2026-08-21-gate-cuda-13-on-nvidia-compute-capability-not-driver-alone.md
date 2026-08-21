---
date: 2026-08-21
title: 'Gate CUDA 13 on NVIDIA compute capability, not the driver version alone'
---

# 2026-08-21 — Gate CUDA 13 on NVIDIA compute capability, not the driver version alone

- **Context:** A user with Volta cards reported that the app defaults him to a
  CUDA-13 backend which "spits an error", and that he has to switch to CUDA 12
  by hand — "cards volta and below are not compatibile with cuda 13". He is
  right, and the gate was wrong in a way the driver check structurally could not
  catch. `get_supported_features` decided `cuda13` purely from the driver
  version (`581.15` on Windows, `580` on Linux). But R580 is the **last** driver
  branch that still supports Maxwell, Pascal and Volta, so those cards
  legitimately report a driver above the CUDA-13 floor and sailed straight
  through — while CUDA Toolkit 13.0 removed code generation for all three
  architectures (5.x / 6.x / 7.0), leaving Turing (7.5) as the floor. The
  resulting `cuda-13.x` archive has no `sm_70` kernels and dies at
  `ggml_cuda_init` with "no kernel image is available for execution on the
  device". `NvidiaInfo.compute_capability` was already produced by the hardware
  plugin, transported in the `gpus` payload and deserialized by both llamacpp
  plugins — and then never read.
- **Decision:** Add a compute-capability floor of **7.5** alongside the existing
  driver floors, in `get_supported_features` in **both**
  [`tauri-plugin-llamacpp-upstream`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs)
  and [`tauri-plugin-llamacpp`](src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs).
  That function is the only point in the funnel that still sees GPU objects —
  everything downstream (`normalizeFeatures`, `determine_supported_backends`,
  the TS rankers) sees five booleans — so no TypeScript change is involved.
  Three deliberate choices:
  1. **Any GPU for the driver, every GPU for the architecture.** The driver is
     one system-wide version, so any qualifying NVIDIA GPU enables a tier.
     Architecture is per card and llama.cpp enumerates and offloads across every
     visible CUDA device, so a single sub-7.5 card vetoes CUDA 13 for the whole
     host. This is what the reporter's dual-NVIDIA machine needs.
  2. **Unknown capability does not gate.** `parse_compute_capability` returns
     `None` for unreadable input and the host keeps CUDA 13. The hardware plugin
     drops a GPU entirely when NVML cannot report its capability, so `None` is
     unreachable in practice; guessing "too old" would strand a Blackwell host
     (CC 10.0 / 12.0) on the CUDA 12.4 archive, which has no kernels for it
     either.
  3. **Tuple comparison, not string or float.** `"10.0" < "7.5"` lexicographically
     and a float parse mangles the minor; `(10, 0) >= (7, 5)` is correct.
  `compute_capability` also gains `#[serde(default)]`: it was a required field,
  so a payload whose `nvidia_info` lacked it would fail deserialization of the
  whole `gpus` argument, and the TS caller swallows that into an *empty*
  supported-backend list — hiding every backend, not just CUDA 13.
- **Consequences:** A Maxwell / Pascal / Volta host is now offered CUDA 12.4
  instead of a CUDA-13 build it cannot load, and — because
  `applyStartupBackendUpgrade()` applies the detected tier for
  `llamacpp-upstream` — an affected user already pinned to CUDA 13 is moved off
  it on the next launch without touching settings. The cost is a mixed rig
  (say Ada + Pascal) losing CUDA 13 for the newer card; that is the conservative
  side of the trade, consistent with the existing ROCm policy in the same file,
  and the manual backend picker still allows an explicit override. The two
  plugins keep the constant duplicated rather than hoisted into a shared crate:
  they are independent crates with deliberately divergent driver floors
  (Windows CUDA 12: `551.61` upstream vs `527.41` fork), so each carries a
  doc comment naming the other as its twin. **Build scripts are unchanged** —
  `Makefile` / `dev-windows.ps1` pick a tier from the driver only and have no
  access to compute capability, but they are dev-side and the runtime gate is
  what users hit. **Verified:** 16 new unit tests across the two crates (Volta /
  Pascal / Maxwell vetoed, Turing 7.5 boundary allowed, Blackwell 10.0 & 12.0
  allowed, mixed dual-GPU host vetoed, unknown capability not vetoed, and a
  serde round-trip guarding the default); both crates' full `backend::tests`
  suites pass and clippy reports no new warnings.
- **Owner:** team.
- **Links:** the 2026-05-26 ADR *Correct the CUDA 13.1 driver gate to NVIDIA's
  documented 581.15*, the 2026-08-13 ADR *Apply the detected backend tier at
  startup for llamacpp-upstream*, files:
  [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs)
  (`MIN_CUDA13_COMPUTE_CAPABILITY`, `parse_compute_capability`,
  `gpu_meets_cuda13_arch_floor`, `get_supported_features`),
  [`src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs)
  (same three symbols),
  [`src-tauri/plugins/tauri-plugin-hardware/src/vendor/nvidia.rs`](src-tauri/plugins/tauri-plugin-hardware/src/vendor/nvidia.rs)
  (producer of `compute_capability`),
  <https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/>.

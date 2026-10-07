---
date: 2026-10-06
title: "Build every stable-diffusion.cpp engine in an Atomic fork, mirrored under the upstream tag"
---

# 2026-10-06 — Build every stable-diffusion.cpp engine in an Atomic fork, mirrored under the upstream tag

- **Context:**
  - **arm64 had no engine.** The app ships for Windows on Arm (NSIS) and arm64 Linux (AppImage), and
    both targets include NVIDIA's arm64 parts: RTX Spark / N1X laptops on Windows and DGX Spark / GB10
    on Linux. leejet/stable-diffusion.cpp publishes no archive for either OS on arm64, so
    `selectDiffusionBackend` returned `null` for every non-x64 host.
  - **Upstream's x64 and macOS archives had gaps of their own:**
    - Linux ROCm nests its files under `build/bin/` with symlinks, which the app's unzip cannot
      reproduce and the core's root-level `sd-server` check does not find;
    - every x64 MSVC archive needs `vcomp140.dll` and the VC++ runtime without shipping them;
    - `win-cuda12` cannot start without an NVIDIA driver;
    - there is no Linux CUDA build and no CUDA 13 build for Windows.
- **Decision:**
  - **One source for every engine.** `AtomicBot-ai/stable-diffusion.cpp` builds all fifteen archives
    from an **unmodified upstream tag**, plus the patch series in `atomic/patches/`. Today that series
    is one build-system patch (libwebm exports under clang on Windows), and no source code differs.
    The workflow is `release-atomic.yml`.
    - **Upstream's nine, with upstream's flags:** `macos-arm64`, `win-cpu/vulkan/cuda12/rocm-x64` plus
      the `win-cudart-cu12` companion, and `linux-cpu/vulkan/rocm-x64`.
    - **Additions:** `linux-cpu-arm64`, `linux-cuda13-arm64` (CUDA 13.0 SBSA), `win-cpu-arm64`,
      `win-cuda13-arm64` (CUDA 13.4, the first toolkit with Windows on Arm), `linux-cuda12-x64` and
      `win-cuda13-x64`. Their CUDA runtime is inside them.
  - **Packaging every archive must pass:**
    - Linux archives are flat and symlink-free, and carry every non-base runtime library (libgomp, the
      CUDA runtime).
    - Windows archives carry the VC++ runtime, vcomp140 included.
    - x64 CUDA builds delay-load `nvcuda.dll`.
    - Every archive except ROCm passes smoke on a GPU-less runner: it starts, lists its devices and
      generates an image over sd-server's HTTP API. On Linux the smoke runs in a bare
      `python:3.12-slim` container.
  - **Windows on Arm** follows llama.cpp's split. clang builds the tree, because ggml-cpu rejects MSVC
    on ARM. MSVC cross-compiles `ggml-cuda.dll` inside sd.cpp's own CMake tree, so `GGML_MAX_NAME=160`
    matches on both sides.
  - **Mirroring.** atomic-chat-conf `mirror-sdcpp.yml` takes every asset from `source_repo` (the fork)
    and re-signs Windows and macOS with Atomic Chat's certificates. Already-signed NVIDIA and Microsoft
    DLLs keep their own signatures. `source_repo=leejet/stable-diffusion.cpp` remains as an emergency
    path. The manifest keeps the upstream tag name, with no `-a<sha>` suffix: installs are matched on
    `tag_name`, and a new name would re-download every user's engine.
  - **Selection.** On arm64 Windows and Linux the ladder is CUDA 13 when the `cuda13` probe passes
    (r580+ driver), then CPU; x64 builds are never offered to an arm64 host. x64 selection is
    unchanged for now: `linux-cuda12-x64` and `win-cuda13-x64` are published but not yet picked. A
    separate decision will switch Linux NVIDIA from Vulkan and Windows Blackwell from CUDA 12.
  - **Visibility.** `PlatformFeature.MEDIA_GENERATION` no longer excludes Windows or Linux arm64, so
    the sidebar's Images and Video, the Hub's media category and Settings → Media show there. On a live
    manifest without arm64 archives the engine card states that reason instead of the pages hiding.
- **Consequences:**
  - **Validation path.** A tag first goes to `backends/sdcpp-manifest.staging.json`, and a test
    installer reads it through `release.yml`'s `sdcpp_manifest_url`. The live manifest moves only after
    the fork's smoke and a hardware check.
  - **Hardware checks done for `master-883-137f740`, with `verify-spark`:**
    - RTX Spark N1X (Windows 11 build 28000, driver 616.00): Z-Image 512² in 23 s, Wan 2.2 TI2V 5B
      832×480×33 in 170 s.
    - GB10 on a rented Vast.ai machine (Ubuntu 24.04, driver 580.173): Z-Image in 5.8 s, Wan 2.2 in
      92 s. That run is what found the missing libgomp.
    - macOS with Metal on an M4 Max.
    - ROCm gets build and structure checks only, as upstream: no runner has the AMD driver.
  - **Known gap.** The clang half of the Windows-on-Arm CUDA build lacks `SD_USE_CUDA`, so the MMA head
    padding for `d_head < 64` is off. It costs speed, not correctness.
  - **Upgrading the tag:** run the fork's `release-atomic.yml` (`targets=all`, `publish`), then the
    mirror. ccache keeps a re-run of one target to minutes; a cold run is bounded by ROCm and
    `win-cuda12` (about 2 h each).
- **Owner:** `team`.
- **Links:**
  - `web-app/src/services/diffusion/backendMatrix.ts`
  - `web-app/src/services/diffusion/install.ts`
  - `web-app/src/lib/platform/const.ts` (`MEDIA_GENERATION`)
  - `.github/workflows/release.yml` (`sdcpp_manifest_url`)
  - AtomicBot-ai/stable-diffusion.cpp `atomic/README.md` and `.github/workflows/release-atomic.yml`
  - atomic-chat-conf `.github/workflows/mirror-sdcpp.yml` and `backends/sdcpp-schema.json`
  - Extends [2026-09-10 mirror, pin and verify](2026-09-10-mirror-pin-and-verify-stable-diffusion-cpp-prebuilts-in-atomic-chat-conf.md)

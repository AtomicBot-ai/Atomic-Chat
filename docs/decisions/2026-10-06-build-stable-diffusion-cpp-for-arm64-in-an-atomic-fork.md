---
date: 2026-10-06
title: "Build stable-diffusion.cpp for arm64 in an Atomic fork, mirrored under the upstream tag"
---

# 2026-10-06 — Build stable-diffusion.cpp for arm64 in an Atomic fork, mirrored under the upstream tag

- **Context:** The app now ships for Windows on Arm (NSIS) and arm64 Linux (AppImage), and both targets
  include NVIDIA's arm64 parts: RTX Spark / N1X laptops (Windows) and DGX Spark / GB10 (Linux).
  leejet/stable-diffusion.cpp publishes no archive for either OS on arm64. Its CI does build a
  `cuda / linux/arm64 / -spark` Docker image, so the source compiles there. Images and video were
  therefore unavailable on those hosts: `selectDiffusionBackend` returned `null` for every non-x64
  host.
- **Decision:**
  - **The fork.** `AtomicBot-ai/stable-diffusion.cpp` builds four archives from an **unmodified
    upstream tag**, plus a patch series in `atomic/patches/`. Today that series is one build-system
    patch: libwebm exports its symbols under clang on Windows. No source code differs. The archives are
    `linux-cuda13-arm64` (CUDA 13.0, SBSA), `linux-cpu-arm64`, `win-cuda13-arm64` (CUDA 13.4, the
    first toolkit with Windows on Arm) and `win-cpu-arm64`. CUDA builds carry sm_121 SASS plus a
    Hopper PTX floor, with the CUDA runtime bundled. The workflow is `release-arm64.yml`.
  - **The Windows build** follows llama.cpp's split. The tree is built with clang, because ggml-cpu
    rejects MSVC on ARM. `ggml-cuda.dll` is cross-compiled with MSVC inside sd.cpp's own CMake tree,
    which keeps `GGML_MAX_NAME=160` identical on both sides.
  - **Mirroring.** `mirror-sdcpp.yml` in atomic-chat-conf takes these archives from the fork's release
    of the same tag. The manifest keeps the upstream tag name, with no `-a<sha>` suffix: installs are
    matched on `tag_name`, and a new name would re-download the engine for every x64 and Mac user
    whose binaries did not change.
  - **Selection on arm64.** On arm64 Windows and Linux, the ladder is CUDA 13 when the `cuda13` probe
    passes (r580+ driver), then CPU. x64 builds are never offered to an arm64 host.
- **Consequences:**
  - **Validation path.** A new arm64 tag first goes to `backends/sdcpp-manifest.staging.json`. A test
    installer is built with `release.yml`'s `sdcpp_manifest_url` input. The live manifest moves only
    after the fork's CI smoke tests (native arm64 runners, real CPU generation over sd-server's HTTP
    API) and the `verify-spark` check on an RTX Spark laptop.
  - **Linux is unconfirmed.** There is no DGX Spark to test on, so Linux arm64 CUDA is covered by CI
    only until one is available.
  - **Known gap.** The clang half of the Windows build lacks `SD_USE_CUDA`, so the MMA head padding for
    `d_head < 64` is off. It costs speed, not correctness.
  - **Upgrading the tag** now means running the fork's workflow before the mirror. A tag without fork
    archives still mirrors as before, and arm64 hosts then get `null` with a manifest-specific reason.
  - **Visibility.** `PlatformFeature.MEDIA_GENERATION` no longer excludes Windows or Linux arm64, so
    the sidebar's Images and Video, the Hub's media category and Settings → Media show there. On a live
    manifest without arm64 archives the engine card states that reason instead of the pages hiding.
- **Owner:** `team`.
- **Links:**
  - `web-app/src/services/diffusion/backendMatrix.ts`
  - `web-app/src/services/diffusion/install.ts`
  - `web-app/src/lib/platform/const.ts` (`MEDIA_GENERATION`)
  - `.github/workflows/release.yml` (`sdcpp_manifest_url`)
  - AtomicBot-ai/stable-diffusion.cpp `atomic/README.md` and `.github/workflows/release-arm64.yml`
  - atomic-chat-conf `.github/workflows/mirror-sdcpp.yml` and `backends/sdcpp-schema.json`
  - Extends [2026-09-10 mirror, pin and verify](2026-09-10-mirror-pin-and-verify-stable-diffusion-cpp-prebuilts-in-atomic-chat-conf.md)

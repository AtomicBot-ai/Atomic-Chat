---
date: 2026-09-10
title: "Mirror, pin and verify stable-diffusion.cpp prebuilts in atomic-chat-conf"
---

# 2026-09-10 — Mirror, pin and verify stable-diffusion.cpp prebuilts in atomic-chat-conf

- **Context:** The llama.cpp backend manifest (`backends/manifest.json`) is a
  closed schema (`tag_name` must match `^b[0-9]+$`) whose client parses the
  platform out of the asset *name*. leejet's asset names embed the CI runner's
  OS version (`Darwin-macOS-26.6.2-arm64`, `Linux-Ubuntu-24.04-x86_64`), which
  changes with the runner image, so name parsing would break on the next tag.
  leejet publishes no Linux CUDA prebuilt (same gap as ggml-org).
- **Decision:** A sibling manifest `backends/sdcpp-manifest.json` with its own
  schema, pinned to one leejet tag (`master-849-d04e895` at introduction) and
  carrying an explicit `backend` id per asset (`macos-arm64`, `win-cuda12-x64`,
  `win-vulkan-x64`, `win-rocm-7.14-x64`, `win-cpu-x64`, `linux-vulkan-x64`,
  `linux-rocm-7.14-x64`, `linux-cpu-x64`, plus the `win-cudart-cu12` companion).
  The client selects on the id and never constructs an asset name. `sha256` and
  `size` come from GitHub's release digest and are verified after download by the
  existing Rust downloader. `download_base` appears once the mirror workflow
  (`mirror-sdcpp.yml`, cloned from `mirror-upstream.yml`) has re-signed and
  re-hosted the archives; until then the client falls back to the upstream
  release CDN. A tag suffixed `-a<sha>` marks an Atomic-built variant; the suffix
  is stripped for the upstream fallback. The binary is not bundled into the
  installer: images are opt-in and the CUDA/ROCm archives are hundreds of MB.
  Only a baseline snapshot of the manifest and catalog is bundled, so an install
  still resolves when `raw.githubusercontent.com` stalls.
- **Consequences:**
  - Selection reuses the hardware facts the llama-upstream extension already
    probes (`get_supported_features`: cuda12/cuda13/vulkan/rocm; the Linux
    Vulkan ≥ 2 GiB gate) but maps them onto sd.cpp's own matrix. It never widens
    the llama matrix.
  - NVIDIA on Linux runs Vulkan until phase 1b (diffusers sidecar) or a
    mirror-built CUDA asset.
  - Windows ROCm assets are not guaranteed per tag; a missing id falls to Vulkan.
  - Install dir: `<dataFolder>/diffusion/backends/<tag>/<backendId>/` with an
    `.atomic-owned` marker and `install.json`; trees without the marker are never
    replaced or removed. An accelerator change installs the new tree first and
    removes the old one only when no session runs from it.
- **Owner:** `team`.
- **Links:**
  - `atomic-chat-conf/backends/sdcpp-manifest.json`, `sdcpp-schema.json`
  - `web-app/src/services/diffusion/{backendMatrix,install}.ts`
  - `scripts/resolve-upstream-backend.mjs --engine sdcpp`
  - Supersedes nothing; complements 2026-08-13 *Mirror and sign upstream llama.cpp releases*.

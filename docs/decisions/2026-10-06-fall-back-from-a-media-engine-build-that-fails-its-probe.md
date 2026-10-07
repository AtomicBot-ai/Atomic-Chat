---
date: 2026-10-06
title: "Fall back from a media engine build that fails its probe, and stop shipping Windows ROCm"
---

# 2026-10-06 — Fall back from a media engine build that fails its probe, and stop shipping Windows ROCm

- **Context:** AMD hosts on Windows were handed `win-rocm-7.14-x64`
  (`sd-master-137f740-bin-win-rocm-7.14.0-x64.zip`). That archive carries
  `sd-cli.exe`, `sd-server.exe` and `stable-diffusion.dll` only, and the DLL
  imports `amdhip64_7.dll` and `hipblas.dll`. Neither is in the archive, and
  `hipblas.dll` is not part of the Adrenalin driver either, so without an
  installed HIP SDK the loader ends the process before it prints a line.
  The llama.cpp ROCm archive, by contrast, ships `amdhip64_7.dll`,
  `amd_comgr.dll` and `rocm_kpack.dll`. The core's `sd-cli --help` probe read
  the empty output as "The downloaded binary is not stable-diffusion.cpp.",
  installation stopped there, and every retry downloaded the same 192 MB.
  The `rocm` feature flag is a PCI-id table lookup and says nothing about the
  HIP runtime on disk.
- **Decision:** `win-rocm` leaves the sdcpp manifests (live and staging), the
  `mirror-sdcpp.yml` matrix and the bundled baseline, so AMD Windows hosts take
  `win-vulkan-x64`. The installer also walks the host's whole backend ladder
  (`diffusionBackendLadder`): a build that unpacks but fails the probe
  (`ENGINE_INSTALL_FAILED`) is remembered per `<tag>/<backendId>` in
  `localStorage`, its unmarked tree and archive are removed, and the next
  build down is installed. Only the last rung's failure reaches the user. The
  core names a loader failure for what it is (`The image engine could not load
  a library it needs.`, with the Windows NTSTATUS or the `ld.so`/`dyld` line
  in the details) and a silent exit as a silent exit.
- **Consequences:** AMD Windows users get the Vulkan build, not ROCm speed. A
  ROCm build can come back once an archive carries its HIP runtime, the way the
  llama.cpp one does. A failed build stays skipped on this machine for that
  tag even after the user installs the missing runtime; a new tag tries every
  rung again. The download panel still reports the failed rung's error before
  the next one downloads.
- **Owner:** `team`.
- **Links:** `web-app/src/services/diffusion/backendMatrix.ts`,
  `web-app/src/services/diffusion/install.ts`,
  `atomic-chat-core/src/diffusion/install.ts` (`probeVerdict`),
  `atomic-chat-conf/backends/sdcpp-manifest.json`,
  `atomic-chat-conf/.github/workflows/mirror-sdcpp.yml`.

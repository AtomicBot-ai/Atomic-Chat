---
date: 2026-07-31
title: "Adopt unified TurboQuant release tags and expand the Linux backend matrix to CUDA/ROCm"
---

# 2026-07-31 — Adopt unified TurboQuant release tags and expand the Linux backend matrix to CUDA/ROCm

- **Context:** `AtomicBot-ai/atomic-llama-cpp-turboquant` stopped publishing one
  GitHub release per backend variant. Release `b10018-1.3.0` carries every
  variant under a single tag named `b<upstream-build>-<fork-semver>`, and it
  adds Linux artifacts the fork never shipped before: `linux-x64-cpu`,
  `linux-x64-cuda-12.4`, `linux-x64-cuda-13.3` and `linux-x64-rocm` (RDNA2 to
  RDNA4, requires a host ROCm runtime). Asset filenames are unchanged
  (`llama-turboquant-<id>.zip` on Windows, `.tar.gz` elsewhere), so only the
  release-tag model and the Linux catalog change. Two client assumptions broke:
  the `atomic-chat-conf` manifest schema required every tag to start
  `turboquant-<id>`, and provider identity was inferred from that same prefix
  (`version.starts_with("turboquant-")`), which silently downgrades fork-only
  `turbo*` KV cache types to `q8_0` on the new tag.
- **Decision:** Resolve the TurboQuant backend index from a single unified
  release tag pinned at an immutable `atomic-chat-conf` revision, and derive
  fork capability from provider identity instead of the tag string. The
  TurboQuant `llamacpp` provider on Linux now selects CUDA 13.3 → CUDA 12.4 →
  ROCm → Vulkan → CPU; ROCm is offered only when an AMD GPU reports a supported
  RDNA2–RDNA4 device id *and* a host ROCm/HIP runtime is present, otherwise the
  host falls back to Vulkan. `llamacpp-upstream` keeps Vulkan as its only Linux
  GPU path regardless of what the shared hardware probe reports, because the
  optimal backend is a property of a provider *and* its pinned release, not of
  the GPU alone. `linux-x64-vulkan` remains the sole bundled Linux fallback.
- **Consequences:** Updating the fork is one manifest edit again, and Linux
  NVIDIA/AMD users get first-class GPU tiers from the fork while upstream users
  keep the artifacts ggml-org actually publishes. Legacy `turboquant-<id>-<sha>`
  installs keep resolving and sort correctly beside unified tags. Backend
  recommendation state, download/hot-swap events and the upgrade popup are now
  scoped by provider *and* release, so one provider's download can no longer
  drive the other's dialog. ROCm detection is deliberately conservative: an
  unrecognised AMD device or a missing runtime yields Vulkan rather than a
  broken GPU build. This supersedes the Vulkan-only Linux clause of the
  2026-06-23 ADR for the `llamacpp` provider (upstream is unaffected) and
  extends the pinned-artifact policy of the 2026-07-28 ADR to unified tags.
- **Owner:** team
- **Links:** the 2026-06-23 ADR *Ship the TurboQuant `llamacpp` provider on
  Windows + Linux …*, the 2026-07-28 ADRs *Pin backend artifacts to verified
  tags* and *Ship dual llama providers on Windows and Linux*, the 2026-07-30 ADR
  *Cache optimal backends for chat upgrade prompts*,
  [TurboQuant b10018-1.3.0](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/tag/b10018-1.3.0),
  `extensions/llamacpp-extension/src/backend.ts`,
  `extensions/llamacpp-extension/src/index.ts`,
  `src-tauri/plugins/tauri-plugin-llamacpp/src/args.rs`,
  `src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs`,
  `web-app/src/hooks/useBackendUpdater.ts`, `Makefile`,
  `atomic-chat-conf` `backends/turboquant-manifest.json` +
  `backends/turboquant-schema.json` + `.github/workflows/validate.yml`

<!--
Supersedes: 2026-06-23-ship-the-turboquant-llamacpp-provider-on-windows-linux-as-a.md
-->

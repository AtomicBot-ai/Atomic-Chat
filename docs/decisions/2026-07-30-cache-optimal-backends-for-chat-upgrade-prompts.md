---
date: 2026-07-30
title: "Cache optimal backends for chat upgrade prompts"
---

# 2026-07-30 — Cache optimal backends for chat upgrade prompts

- **Context:** The backend-mismatch prompt could identify a GPU build that fell
  back to CPU, but a user intentionally running the CPU backend only received a
  faster-backend prompt after onboarding or the manual "Find optimal backend"
  action had left an ephemeral recommendation behind. Skipping onboarding,
  completing an upgrade, or restarting could remove that knowledge. The
  upstream and Turboquant providers also require different release tags and
  backend ids for the same CUDA/Vulkan-capable host.
- **Decision:** Detect optimal backends silently after extension and fresh
  hardware readiness, cache successful results independently for
  `llamacpp-upstream` and `llamacpp`, and refresh records older than 24 hours.
  The common hardware preflight short-circuits confirmed CPU-only hosts without
  network or backend probes. Detection never opens startup UI: model-load
  mismatch reporting consumes the provider cache and the first subsequent chat
  send surfaces the shared lower-corner upgrade prompt. Each extension remains
  authoritative for mapping hardware to its own concrete backend artifact.
- **Consequences:** Users who skipped backend onboarding can discover a faster
  CUDA/Vulkan path from normal chat use, while CPU-only users are not prompted.
  A stale successful result remains available when an offline refresh fails,
  and install/download flows may clear ephemeral dialog state without erasing
  hardware knowledge. Startup performs bounded background work at most once per
  24-hour cache period; upstream is checked before Turboquant to prioritize the
  default provider. The old once-ever Turboquant prompt is retired in favor of
  the shared provider-aware chat prompt.
- **Owner:** team.
- **Links:** [`extensions/llamacpp-upstream-extension/src/index.ts`](../../extensions/llamacpp-upstream-extension/src/index.ts),
  [`extensions/llamacpp-extension/src/index.ts`](../../extensions/llamacpp-extension/src/index.ts),
  [`web-app/src/providers/StartupBackendCoordinator.tsx`](../../web-app/src/providers/StartupBackendCoordinator.tsx),
  [`web-app/src/hooks/useBackendMismatch.ts`](../../web-app/src/hooks/useBackendMismatch.ts),
  [`web-app/src/containers/dialogs/SuboptimalBackendDialog.tsx`](../../web-app/src/containers/dialogs/SuboptimalBackendDialog.tsx).

Supersedes the once-ever Turboquant popup portion of
`2026-06-24-add-a-find-optimal-backend-button-a-once-ever-post-first-launch.md`;
manual "Find optimal backend" remains available.

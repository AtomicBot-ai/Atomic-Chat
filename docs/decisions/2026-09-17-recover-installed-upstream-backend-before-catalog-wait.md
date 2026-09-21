---
date: 2026-09-17
title: "Recover an installed upstream backend before waiting for the catalog"
---

# 2026-09-17 — Recover an installed upstream backend before waiting for the catalog

- **Context:** A downloaded Qwen3.5 model could not start because the persisted
  upstream selection was `b10431/macos-arm64`, while both the installed backend
  and the installed extension catalog used `b10809`. The installed extension
  awaited `configureBackendsPromise` indefinitely before trying the existing
  local fallback. The source already bounded that wait to 20 seconds, but still
  delayed usable local backends and could enter an unbounded download after
  expiry when no compatible build existed.
- **Decision:** On the upstream model-load path, check the selected executable
  first. If it is absent, reuse the existing same-variant compatibility lookup
  and validate the replacement executable before waiting for configuration.
  Persist the recovered selection through the existing settings/event path.
  Never replace an installed selection just because a newer build is present,
  and abandon recovery if the selection changed while scanning disk. If no
  compatible build exists, retain the 20-second configuration wait, recheck
  local availability, and fail with an actionable Settings error on timeout.
- **Consequences:** Stale concrete selections can recover offline immediately,
  including on macOS ARM/Intel, Windows and Linux without changing GPU tiers.
  An installation still running after the deadline can finish in the background;
  the user retries loading after it finishes. The unresolved `latest/` sentinel,
  explicit install/update operations, and ordinary download paths when no
  configuration pass is pending retain their existing behavior. This is not a
  global download timeout. The installed extension must be rebuilt/repackaged
  to receive the fix; user data and installed bundles are not patched in place.
- **Owner:** team.
- **Links:** `extensions/llamacpp-upstream-extension/src/index.ts`
  (`startLoad`, `reconcileInstalledBackendForLoad`,
  `waitForBackendConfiguration`), tests in
  `extensions/llamacpp-upstream-extension/src/test/index.test.ts`.

Supersedes: [2026-09-16 load-wait decision](2026-09-16-bound-the-model-load-wait-on-backend-configuration.md)
only for missing concrete selections after the configuration deadline.

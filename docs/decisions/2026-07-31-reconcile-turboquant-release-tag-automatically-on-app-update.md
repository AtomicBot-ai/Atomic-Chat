---
date: 2026-07-31
title: "Reconcile the TurboQuant release tag automatically on app update"
---

# 2026-07-31 — Reconcile the TurboQuant release tag automatically on app update

- **Context:** Shipping a model that only runs on a newer llama.cpp build
  requires every user to actually be on that build. Installers bundle exactly
  one tier per provider — `windows-x64-cpu` on Windows, `linux-x64-vulkan` on
  Linux, `macos-arm64` on macOS — so an app update only carries the new release
  tag for that one tier. `configureBackends()` force-switches solely when the
  bundled tier has the *same* backend type as the configured one, and its
  auto-upgrade path refuses any target that is not already on disk ("target not
  installed locally"). Anyone whose GPU tier was fetched at runtime — CUDA,
  ROCm, or Windows Vulkan — therefore stays on the tag they first downloaded,
  indefinitely. Neither popup rescues them: `recheckOptimalBackend()` compares
  backend *categories*, so a CUDA user already counts as optimal, and the
  version-update toast in `BackendUpdater` is wired only to `llamacpp-upstream`
  via the default `useBackendUpdater()` config. macOS is unaffected because
  its single bundled tier always matches.
- **Decision:** After `configureBackends()` resolves, the TurboQuant extension
  runs `reconcileBackendReleaseTag()` on Windows and Linux: it asks the existing
  `checkBackendForUpdates()` for the newest tag of the backend type already in
  use and, when one exists, downloads and hot-swaps to it through
  `downloadRecommendedBackend()`. The target comes from Rust
  `find_latest_version_for_backend` over the merged local+manifest catalog, and
  the running backend is itself part of that catalog, so the result is never
  older — this can upgrade but never downgrade. A type guard rejects any target
  outside the current backend family, allowing only the migrated form of a
  legacy id. The global `BackendUpdater` gains a progress-only `useBackendUpdater`
  instance scoped to `llamacpp`, because an unattended reconcile can pull several
  hundred megabytes (Linux CUDA is ~500 MiB) and must never be invisible; the
  recommendation modal and the version toast stay upstream-owned so two providers
  cannot contend for one dialog. The `llamacpp-upstream` hard pin to `b9937`
  is deliberately left alone — upstream keeps its own version policy.
- **Consequences:** A TurboQuant release becomes deliverable by shipping an app
  update: GPU users converge on the bundled release's tag on next launch instead
  of waiting for a prompt that never fires. The reconcile overrides a manually
  chosen older tag while preserving the backend type, which is the same contract
  the existing version-update toast already had. A failed download retries on
  every subsequent launch, matching the upstream `enforcePinnedBackendVersion`
  precedent; that is acceptable because a user stuck on the old tag cannot run
  the model the update was shipped for. Every failure path is non-fatal: the
  working backend stays configured and the session survives. Users on metered
  connections will see an unrequested download — surfaced, but not gated behind
  consent. Should that become a problem, the same call site can be demoted to
  raising the existing recommendation event instead of downloading.
- **Owner:** team
- **Links:** the 2026-07-31 ADR *Adopt unified TurboQuant release tags and expand
  the Linux backend matrix to CUDA/ROCm*, the 2026-07-28 ADRs *Pin backend
  artifacts to verified tags* and *Ship dual llama providers on Windows and
  Linux*, the 2026-07-30 ADR *Cache optimal backends for chat upgrade prompts*,
  `extensions/llamacpp-extension/src/index.ts`,
  `web-app/src/containers/dialogs/BackendUpdater.tsx`,
  `web-app/src/hooks/useBackendUpdater.ts`,
  `src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs`

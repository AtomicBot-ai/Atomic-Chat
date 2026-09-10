---
date: 2026-06-15
title: "Stop the `llamacpp-upstream` auto-upgrade from wiping turboquant backends (point cleanup at the provider's own tree) + recover the bundled macOS turboquant backend if missing (ATO-153)"
---

# 2026-06-15 — Stop the `llamacpp-upstream` auto-upgrade from wiping turboquant backends (point cleanup at the provider's own tree) + recover the bundled macOS turboquant backend if missing (ATO-153)

- **Context:** On macOS both llama.cpp providers ship side-by-side and **share
  the on-disk GGUF tree** (`MODELS_PROVIDER_ROOT='llamacpp'`), but their
  **backend binaries are isolated** —
  `<jan>/llamacpp/backends/` (turboquant, bundled-in-resources, *not* in any
  release stream) vs `<jan>/llamacpp-upstream/backends/` (downloaded from
  ggml-org). When the upstream provider auto-upgraded its backend, the cleanup
  step in
  [`updateBackend`](extensions/llamacpp-upstream-extension/src/index.ts)
  built the "remove old versions" path from a **hardcoded `'llamacpp'`**
  segment instead of the provider id, so
  [`removeOldBackendVersions`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs)
  ran against the **turboquant** `llamacpp/backends` dir and deleted every
  version that didn't equal the upstream `latest_version` — i.e. **all**
  turboquant backends (none match an upstream tag). Turboquant-bound models
  then failed to load with the generic "not installed" error, even though the
  turboquant binary ships in app resources ([ATO-153](https://linear.app/atomicchat/issue/ATO-153)).
- **Decision (per chosen scope — Fix #1 primary + Fix #3 recovery; Fix #2
  deferred):**
  1. **#1 Primary fix.** In `updateBackend` the cleanup `backendsDir` is now
     built from `this.providerId` (= `llamacpp-upstream`), never the literal
     `'llamacpp'`, so the upstream auto-upgrade only ever prunes its **own**
     backends tree. This matches `getBackendDir`
     ([`backend.ts`](extensions/llamacpp-upstream-extension/src/backend.ts)),
     which already correctly uses the `llamacpp-upstream` segment — the
     hardcoded literal in the cleanup path was the lone inconsistency.
  2. **#3 Recovery (defense-in-depth).** In
     [`ensureBackendReady`](extensions/llamacpp-extension/src/index.ts) (the
     turboquant provider), before throwing the terminal "not installed" error
     on macOS, attempt `tryInstallBundledBackend()` and re-check
     `isBackendInstalled`; if the bundled SHA matches the model's pinned
     `version_backend` this fully restores a backend wrongly deleted by a
     *pre-fix* upstream upgrade (otherwise it's a harmless no-op and we fall
     through to the unchanged error). This rescues users already bricked by the
     #1 bug without a reinstall.
- **Consequences:** Upstream backend upgrades no longer touch the turboquant
  tree; already-affected macOS users self-heal on next turboquant start.
  **Deliberately NOT done:** Fix #2 (a Rust-side guard in
  `remove_old_backend_versions` to refuse a `backends_dir` outside the calling
  provider) — the TS fix removes the only caller that passed the wrong dir, and
  the Rust guard is a larger cross-plugin change deferred as belt-and-suspenders.
  Windows/Linux ship only `llamacpp-upstream` (no turboquant tree to wipe), so
  this is a macOS-only impact; the recovery is macOS-gated. Scope: 2 extension
  TS files + 1 test; no Rust, IPC, on-disk layout, or settings-schema change.
  **Verified:** rolldown build clean on both extensions (`dist/index.js`
  213.54 kB upstream / 181.56 kB turboquant, exit 0 — the authoritative compile;
  standalone `tsc --noEmit` module-resolution noise is pre-existing per prior
  ADRs); new vitest case *cleanup target directory (ATO-153)* passes (asserts
  the cleanup `joinPath` resolves the `llamacpp-upstream` tree, never
  `llamacpp`) — suite 36 passed / 9 failed, the 9 failures confirmed
  pre-existing by a stash-baseline on HEAD (35 passed / 9 failed). Extensions
  have no eslint config (no `lint` script), consistent with prior ADRs.
- **Owner:** team.
- **Links:** [ATO-153](https://linear.app/atomicchat/issue/ATO-153), the
  2026-05-19 ADR *Ship upstream `ggml-org/llama.cpp` as a second macOS
  provider* (shared-GGUF / isolated-backends model), the 2026-05-22 ADR
  *Windows ships only `llamacpp-upstream`*, files:
  [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
  (`updateBackend` cleanup `backendsDir`),
  [`extensions/llamacpp-extension/src/index.ts`](extensions/llamacpp-extension/src/index.ts)
  (`ensureBackendReady` bundled-backend recovery),
  [`extensions/llamacpp-upstream-extension/src/test/index.test.ts`](extensions/llamacpp-upstream-extension/src/test/index.test.ts)
  (ATO-153 cleanup-path test),
  [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs)
  (`remove_old_backend_versions`).

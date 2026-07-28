---
date: 2026-06-16
title: "Treat empty/incomplete `llamacpp-upstream` backend folders as not-installed, fall back to a compatible installed backend on load, and sweep orphan folders at startup (ATO-179)"
---

# 2026-06-16 — Treat empty/incomplete `llamacpp-upstream` backend folders as not-installed, fall back to a compatible installed backend on load, and sweep orphan folders at startup (ATO-179)

- **Context:** A user hit `BINARY_NOT_FOUND` on model load: the model's pinned
  `version_backend` pointed at a backend whose on-disk folder
  (`llamacpp-upstream/backends/<tag>/<type>/`) was an **empty stub** (no
  `llama-server` exe — left by a failed/interrupted download or a pruned
  upstream tag), even though a **working compatible** backend of the same type
  (different tag, e.g. `b9652/macos-arm64` vs the pinned `b9642/macos-arm64`)
  was already installed. The load dead-ended instead of self-healing. Root
  cause is not the install check itself —
  [`isBackendInstalled`](extensions/llamacpp-upstream-extension/src/backend.ts)
  and the Rust `get_local_installed_backends` already gate on exe presence — but
  three missing recoveries: (1) a stale incomplete dir for the exact pinned pair
  wasn't cleared before re-download, (2) when the pinned backend couldn't be
  obtained at all there was no fallback to a working sibling, only a throw, and
  (3) nothing ever swept the orphan stub folders.
- **Decision (the issue's 3 acceptance criteria; extension-only, no Rust/IPC/
  schema change):**
  1. **AC1 — clear stale stub before re-download.** In
     [`ensureBackendReady`](extensions/llamacpp-upstream-extension/src/index.ts),
     when the requested pair isn't installed (exe missing), `fs.rm` its dir (if
     present) before attempting the download so decompress writes into a clean
     dir and the model is never stuck on an empty stub.
  2. **AC2 — fall back to a compatible installed backend.** `ensureBackendReady`
     now returns the **effective** `{ version, backend }` and takes an
     `allowFallback` flag (true only from the load paths `performLoad` /
     `getDevices`; explicit user-driven backend switches keep strict
     throw-on-failure). When the pinned backend can't be obtained, new
     `findCompatibleInstalledBackend(type)`
     ([`backend.ts`](extensions/llamacpp-upstream-extension/src/backend.ts))
     returns the newest installed backend of the **same type** (any tag), the
     corrected `version_backend` is persisted via new `persistVersionBackend`
     (settings + in-memory config + `settingsChanged` emit), and the load runs
     on it instead of failing. **Compatibility is deliberately same-type-only**
     (every tag of a type targets the same platform/GPU variant and is
     interchangeable); cross-type fallback (e.g. cuda→cpu) is intentionally NOT
     automatic — it's a feature/perf trade-off that must stay a user choice.
  3. **AC3 — sweep orphans at startup.** New `cleanupIncompleteBackends()`
     ([`backend.ts`](extensions/llamacpp-upstream-extension/src/backend.ts))
     scans `llamacpp-upstream/backends/`, `fs.rm`s any `<tag>/<type>` dir with no
     exe and any now-empty `<tag>` dir, and returns the removed ids. Called from
     `onLoad` right **after** `activatePendingBackend` (a completed pending
     backend has a valid exe → never removed) and before `configureBackends`.
     Scoped strictly to the upstream backends tree — the shared GGUF model tree
     and the turboquant `llamacpp` backends are never touched.
- **Consequences:** A model pinned to a missing/incomplete backend now
  re-downloads cleanly, and if that fails but a compatible build is on disk it
  loads on the sibling (with the pin corrected) instead of `BINARY_NOT_FOUND`;
  empty stub folders self-clean at startup. Same-type-only fallback exactly
  covers the reported case (`b9642`→`b9652`, both `macos-arm64`). macOS
  turboquant `llamacpp` and MLX are untouched (this is the upstream provider).
  **Verified:** rolldown build clean (`dist/index.js` 217.54 kB, exit 0 — the
  authoritative compile); vitest suite 88 passed / 14 failed — the 14 failures
  are **pre-existing** (stash-baseline on HEAD: identical 14 failed / 88 passed,
  env/network `__TAURI_INTERNALS__` in the sandbox), unchanged by this diff.
- **Owner:** team.
- **Links:** [ATO-179](https://linear.app/atomicchat/issue/ATO-179),
  [ATO-176](https://linear.app/atomicchat/issue/ATO-176), the 2026-06-15 ADR
  *Stop the `llamacpp-upstream` auto-upgrade from wiping turboquant backends …
  (ATO-153)*, files:
  [`extensions/llamacpp-upstream-extension/src/backend.ts`](extensions/llamacpp-upstream-extension/src/backend.ts)
  (`findCompatibleInstalledBackend`, `cleanupIncompleteBackends`),
  [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
  (`ensureBackendReady`, `persistVersionBackend`, `performLoad`, `getDevices`,
  `onLoad`).

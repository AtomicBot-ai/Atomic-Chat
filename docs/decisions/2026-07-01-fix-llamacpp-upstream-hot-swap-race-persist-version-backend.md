---
date: 2026-07-01
title: "Fix `llamacpp-upstream` hot-swap race: persist `version_backend` *before* unloading, not after (Windows \"optimal backend selected but still running on CPU\" bug)"
---

# 2026-07-01 — Fix `llamacpp-upstream` hot-swap race: persist `version_backend` *before* unloading, not after (Windows "optimal backend selected but still running on CPU" bug)

- **Context:** Windows user report — after "Find optimal backend" downloads
  and applies a GPU backend onto a host that was already running a loaded
  model on the bundled CPU build, the Settings UI immediately shows the new
  backend as active, but the running `llama-server.exe` process silently
  stays on the **old** CPU build (no crash, no error — just wrong binary,
  confirmed by throughput staying CPU-bound). Root cause is a hot-swap
  ordering race in `applyBackendLive()`
  ([`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)),
  the private helper `downloadRecommendedBackend()` calls after a successful
  download to apply the new backend without a full app restart. The old
  order was: (1) `getLoadedModels()` → (2) `unload()` every loaded model →
  (3) `updateBackend()` (persists settings + commits
  `this.config.version_backend` to the new string). Step (2)'s `unload()`
  flips the model's server status to stopped, which the web-app's
  local-model auto-start effect
  ([`ChatInput.tsx`](web-app/src/containers/ChatInput.tsx), the
  `ensureLocalModelRunning` effect) reacts to *immediately* by calling
  `switchToModel()` → `performLoad()`. `performLoad()` reads
  `cfg.version_backend` off a synchronous snapshot of `this.config` taken at
  call time — so if that auto-reload fires before step (3) commits (a race
  window Windows widens with the deliberate ~1s delay inside
  `updateBackend()`), the auto-reload spawns a fresh `llama-server.exe`
  against the **still-old** `version_backend`, then `updateBackend()`
  finishes a moment later and flips the UI/config to the new value — leaving
  the UI and the actually-running process permanently out of sync until the
  next manual restart. Confirmed the Rust-side process-termination path
  (`unload_llama_model` / `force_terminate_process` / `find_session_by_model_id`
  in `tauri-plugin-llamacpp-upstream`) is not at fault — termination is
  reliable; this is purely a TS-side config-commit-vs-reload ordering bug.
- **Decision (scope: `llamacpp-upstream-extension` only — the user
  explicitly declined mirroring it into the turboquant `llamacpp-extension`,
  which carries the byte-identical pattern but is macOS-only and not the
  reported bug):** Reorder `applyBackendLive()` so `updateBackend()` commits
  the new `version_backend` into `this.config` **before** any loaded model is
  unloaded: (1) `getLoadedModels()` (best-effort, unchanged) → (2)
  `updateBackend(backendString)`, now throwing early (and touching **no**
  loaded model) if `wasUpdated` is false → (3) unload each previously-loaded
  model (best-effort, log-and-continue, unchanged). Any auto-reload the
  unload step triggers now reads the already-committed new backend. A
  `updateBackend()` failure is also now strictly safer than before — a
  working session is never killed on a failed hot-swap attempt, whereas the
  old order unloaded first and could fail on the update, stranding the user
  model-less until `activatePendingBackend()` retried on next launch.
- **Consequences:** Windows (and any other platform driving
  `llamacpp-upstream`) users who hot-swap onto a better backend while a
  model is loaded now actually run on the new backend the moment the UI
  reports it, closing the "optimal backend selected but silently still on
  CPU" gap. **Deliberately NOT mirrored into `extensions/llamacpp-extension/`
  (the TurboQuant provider, macOS-only)** — it has the identical
  unload-then-update ordering in its own `applyBackendLive()` and is
  logically exposed to the same race, but is out of scope for this fix per
  explicit user decision; a future ADR should port this reorder there if the
  same symptom is ever reported on macOS TurboQuant. No IPC, Rust,
  settings-schema, or on-disk-layout change — pure reorder inside one
  extension method. **Verified:** rolldown build clean
  (`dist/index.js` 240.63 kB, exit 0 — the authoritative compile);
  `ReadLints` clean on the edited file.
- **Owner:** team.
- **Links:** §4.2 *LLM backend*, the 2026-06-15/16 ADRs on
  `llamacpp-upstream` backend fallback/recovery (the broader hot-swap /
  fallback machinery this method belongs to), files:
  [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
  (`applyBackendLive`, `downloadRecommendedBackend`, `updateBackend`),
  [`web-app/src/containers/ChatInput.tsx`](web-app/src/containers/ChatInput.tsx)
  (the local-model auto-start effect that triggered the race).

---

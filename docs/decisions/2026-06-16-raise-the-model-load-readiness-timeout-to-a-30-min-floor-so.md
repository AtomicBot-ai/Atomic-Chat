---
date: 2026-06-16
title: "Raise the model-load readiness timeout to a 30-min floor so large/cold-storage loads aren't cut off at 600s (ATO-188, MODEL_LOAD_TIMED_OUT)"
---

# 2026-06-16 — Raise the model-load readiness timeout to a 30-min floor so large/cold-storage loads aren't cut off at 600s (ATO-188, MODEL_LOAD_TIMED_OUT)

- **Context:** Bug #7 of epic [ATO-181](https://linear.app/atomicchat/issue/ATO-181)
  ([ATO-188](https://linear.app/atomicchat/issue/ATO-188)) bundles four small
  but deterministic download/load error buckets (PostHog 30d): `IO_ERROR`
  (34/11u — `Bad CPU type in executable`, wrong-arch binary), `BINARY_NOT_FOUND`
  (13/12u — backend binary missing / not shipped), `MODEL_LOAD_TIMED_OUT`
  (11/7u — `Timeout: 600s`), `MODEL_FILE_CORRUPT` (2/1u). The
  `MODEL_LOAD_TIMED_OUT` bucket is the one with a clean, code-side, verifiable
  root cause: the model-load **readiness** wait in both llama.cpp extensions
  passed `Number(this.timeout)` (the user-facing "connection and load timeout",
  default **600s**) to `loadLlamaModel(...)`. Large models on slow / cold (first
  read, network) storage legitimately need >10 min to mmap + warm up and report
  ready, so `llama-server` was killed at 600s with a raw `MODEL_LOAD_TIMED_OUT`
  ([`commands.rs`](src-tauri/plugins/tauri-plugin-llamacpp/src/commands.rs)
  emits the `Timeout: {}s` message). The issue's own fix direction is "raise the
  timeout".
- **Decision (scope = MODEL_LOAD_TIMED_OUT only; the other three buckets are
  build/release-pipeline-coupled and not fixable/verifiable from the app
  codebase here):** Add a module-level helper `modelLoadReadyTimeoutSecs()` +
  constant `MODEL_LOAD_READY_TIMEOUT_FLOOR_SECS = 1800` (30 min) to **both**
  [`extensions/llamacpp-extension/src/index.ts`](extensions/llamacpp-extension/src/index.ts)
  and
  [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts),
  and use it at every `loadLlamaModel(...)` **readiness** call site (turboquant:
  2 — initial + text-only mmproj retry; upstream: 3 — + the MTP-disable retry).
  The effective load-ready timeout is `max(configured, 1800)`, so it honors a
  *larger* user-configured value and floors everyone (incl. existing users
  stuck at the persisted 600) to 30 min. **The streaming / connection timeout is
  unchanged** — the two `stream_local_http` sites still use
  `Number(this.timeout) || 600`, and `settings.json` / the class default are
  untouched (most surgical: only the "wait for server ready" window grows).
- **Consequences:** Large-model first loads on slow disks no longer hard-fail at
  600s. **Trade-off (accepted):** a user who *lowered* the timeout for fast-fail
  loses that on the load-ready path (streaming still respects their value) — a
  rare case, and load-readiness fast-fail is rarely desirable. **Deliberately
  NOT done (out of scope, separate causes):** `IO_ERROR` "Bad CPU type"
  (wrong-arch bundled/downloaded binary — a build/release-pipeline issue),
  `BINARY_NOT_FOUND` (backend not shipped / not downloaded — partly addressed by
  the 2026-06-15 ATO-153 bundled-backend recovery), and `MODEL_FILE_CORRUPT`
  (post-download checksum + retry — a download-verification feature, gated by the
  `skipVerification`-default path). No progress-bar UI for slow loads (a larger
  UX change). Scope: 2 extension TS files; no Rust, IPC, settings-schema, or
  on-disk-layout change. **Verified:** rolldown build clean on both extensions
  (`dist/index.js` 186.14 kB turboquant / 219.81 kB upstream, exit 0 — the
  authoritative compile per prior ADRs); the two streaming-timeout sites
  confirmed unchanged. Extensions have no eslint config (no `lint` script),
  consistent with prior ADRs.
- **Owner:** team.
- **Links:** [ATO-188](https://linear.app/atomicchat/issue/ATO-188),
  [ATO-181](https://linear.app/atomicchat/issue/ATO-181),
  [ATO-116](https://linear.app/atomicchat/issue/ATO-116),
  [ATO-135](https://linear.app/atomicchat/issue/ATO-135), the 2026-06-15 ADR
  *Stop the `llamacpp-upstream` auto-upgrade from wiping turboquant backends …
  (ATO-153)*, files:
  [`extensions/llamacpp-extension/src/index.ts`](extensions/llamacpp-extension/src/index.ts)
  (`MODEL_LOAD_READY_TIMEOUT_FLOOR_SECS`, `modelLoadReadyTimeoutSecs`),
  [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts),
  [`src-tauri/plugins/tauri-plugin-llamacpp/src/commands.rs`](src-tauri/plugins/tauri-plugin-llamacpp/src/commands.rs)
  (`ModelLoadTimedOut` emission).

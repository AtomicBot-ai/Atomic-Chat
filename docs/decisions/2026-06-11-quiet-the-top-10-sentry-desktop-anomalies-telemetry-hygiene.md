---
date: 2026-06-11
title: "Quiet the top-10 Sentry desktop anomalies: telemetry hygiene (downgrade/throttle/dedup) + two real fixes (sharded GGUF 8.3 path, native-crash classification)"
---

# 2026-06-11 — Quiet the top-10 Sentry desktop anomalies: telemetry hygiene (downgrade/throttle/dedup) + two real fixes (sharded GGUF 8.3 path, native-crash classification)

- **Context:** The `atomic-chat-desktop` Sentry project was drowning in events
  (top issue ~thousands). Root cause is architectural amplification, not ten
  separate bugs: the [`SentryLogger`](src-tauri/src/core/telemetry/mod.rs) bridge
  (`wrap_logger`) turns **every** Rust `log::error!` into a crash-level Sentry
  event with no severity filter, throttle, or dedup, and the frontend choke point
  ([`switchModel.ts`](web-app/src/utils/switchModel.ts)) captured Sentry on
  **every** failed load with no throttle. One failed model load fanned out into 3+
  events (frontend `Error in load command` + Rust `exited with error code N` + Rust
  `Invalid path`), and a tight auto-start retry loop multiplied that into hundreds.
  Mapping of the 10 issues → workstreams: `-1B`/`-T` (exit 1/256) → WS1.1 duplicate
  exit-code log; `-6D`/`-6C` (Invalid model path) → WS1.2 + WS2; `-4` (AMD GPU
  memory probe) → WS1.3; `-Z` (Connection refused) → WS1.4; `-9`/`-3`/`-57`
  (`Error in load command`) → WS1.5 + WS3.1 (sharded GGUF, the true root of `-9`);
  `-A` (`0xC0000005` access violation) → WS3.2.
- **Decision:** Three workstreams; **no** change to the public `localhost:1337/v1`
  contract, no legacy `jan*` rename, no patch of the upstream llama.cpp binary
  (only defense against its segfault).
  - **WS1 — telemetry hygiene (kills ~90% of volume).** Recoverable/expected
    conditions log `warn!`/`debug!` (the bridge demotes those to breadcrumbs, not
    crash events); duplicates and probe spam are silenced; the frontend capture is
    throttled.
    1. **WS1.1** — in both
       [`tauri-plugin-llamacpp-upstream/src/commands.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/commands.rs)
       and [`tauri-plugin-llamacpp/src/commands.rs`](src-tauri/plugins/tauri-plugin-llamacpp/src/commands.rs):
       the process-exit logs (both the early-exit and the ready-loop blocks)
       dropped `error!` → `warn!` — the structured error is already reported once
       by the frontend choke point, so the Rust log was a pure duplicate.
    2. **WS1.2** — in both
       [`path.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/path.rs):
       `Invalid or inaccessible model/mmproj path` (`ModelFileNotFound`) dropped
       `error!` → `warn!` (a deleted/moved file is a user condition, not a crash).
    3. **WS1.3** — [`tauri-plugin-hardware/src/vendor/amd.rs`](src-tauri/plugins/tauri-plugin-hardware/src/vendor/amd.rs):
       the Windows `Failed to get AMD GPU memory usage` probe (fires every ~5s)
       dropped `error!` → `debug!` (the caller already degrades via
       `get_usage_unsupported()`).
    4. **WS1.4** — [`proxy.rs`](src-tauri/src/core/server/proxy.rs):
       `Proxy request to model failed` dropped `error!` → `warn!` (a refused proxy
       connection is a downstream symptom of the server not being up; the PostHog
       `error_kind` is still recorded).
    5. **WS1.5** — [`telemetry.ts`](web-app/src/lib/telemetry.ts) +
       [`switchModel.ts`](web-app/src/utils/switchModel.ts): new
       `shouldCaptureModelLoadSentry(model, code)` (independent map mirroring the
       existing PostHog `shouldEmitModelLoadFailure`, same 5-min window) gates the
       `captureHandledError` call, and `isRecoverableModelLoadCode` skips Sentry
       entirely for `MODEL_FILE_NOT_FOUND` / `BINARY_NOT_FOUND` /
       `MULTIMODAL_PROJECTOR_LOAD_FAILED`. **Systemic backstop:**
       [`mod.rs::before_send`](src-tauri/src/core/telemetry/mod.rs) now drops
       fingerprint-identical events (message + logentry + first exception + level)
       repeating within a 60s window (`is_duplicate_event`, bounded map, fails
       open), so any future `error!` flood self-limits.
  - **WS2 — stop the retry loop at the source (`-6D`, the dominant multiplier).**
    The initiator is the ChatInput auto-start effect
    ([`ChatInput.tsx`](web-app/src/containers/ChatInput.tsx)): a failed
    `switchToModel` flips `serverStatus`→`stopped` and `loadingModel`→`false`,
    **both effect deps**, so the effect re-fires and reloads on a fresh random
    port every ~1s (961 events / 22 min for one missing model). Fix: `switchModel.ts`
    records the last auto-start outcome per `(provider, model)` —
    `shouldAttemptAutoStart()` returns false for terminal codes
    (`MODEL_FILE_NOT_FOUND` / `BINARY_NOT_FOUND`, never auto-retried) and backs off
    others 30s; a success (or already-serving) clears the record. The auto-start
    effect consults it before calling `switchToModel`; **explicit user switches
    (dropdown / send) bypass the gate**, so a manual retry is always possible.
  - **WS3 — the two real functional defects.**
    1. **WS3.1 (root of `-9`)** — sharded GGUF on Windows. `validate_model_path`
       passed split files through `get_short_path`, mangling
       `model-00001-of-00003.gguf` → 8.3 `MODEL~1.GGU`; the `~N` index ≠ the split
       index, so llama.cpp rejects the load (`illegal split file idx: 2 … must be
       loaded with the first split`) and short names break sibling-split discovery.
       Fix (both plugins): new `is_split_gguf_name` (no regex — manual
       `-NNNNN-of-NNNNN.gguf` tail check) skips 8.3 conversion for split names,
       keeping the long path; unit-tested.
    2. **WS3.2 (`-A`)** — `llama-server` native crash (`3221225477` =
       `STATUS_ACCESS_VIOLATION`; Unix `SIGSEGV`/`SIGABRT`) left empty stderr, so
       `from_stderr` only yielded the opaque generic process error. New
       `LlamacppError::from_exit_status` (both plugins) classifies recognised crash
       exit codes into an **actionable** message hinting at an incompatible model /
       unsupported speculative-decoding (MTP) config, while still preferring a
       specific stderr cause (OOM/arch/projector) when present. The commands.rs
       blocks call it instead of `from_stderr` on non-success exit. **Investigation
       flag:** the observed crashes were MTP on **gemma-4-12B** on Windows upstream
       — the true bug is in the upstream binary (related to the ATO-122 MTP
       capability gate); this ADR only adds defense + diagnostics, MTP-on-Windows
       for gemma-4 needs a separate upstream-tracking task.
- **Consequences:** The recoverable/duplicate/probe conditions no longer become
  Sentry crash events; the `-6D` loop is cut at its source; sharded GGUF loads on
  Windows; native crashes get an actionable message instead of `[object Object]`-
  class opacity. **Lossy by design:** exact retry/repeat counts within the throttle
  & dedup windows are not preserved (accepted — the dashboards are device-weighted);
  the upstream segfault itself is not fixed. Scope: 2 Rust plugins (commands/path/
  error), 1 hardware plugin, the proxy + Rust telemetry backstop, and 3 web-app
  files (telemetry/switchModel/ChatInput) — no IPC, on-disk layout, or
  settings-schema change. **Verified:** `cargo check` 0 errors on
  `Atomic-Chat` + both llamacpp plugins + hardware (pre-existing dead_code warnings
  only); new `is_split_gguf_name` unit test passes in both plugins; `tsc -b` clean;
  `yarn lint` clean on the 3 touched web-app files (the 3 `ttft-timing.ts` errors +
  the `processImageFiles` warning are pre-existing and untouched); `ReadLints`
  clean on all edited files.
- **Owner:** team.
- **Links:** Sentry `atomic-chat-desktop` top-10 (`-1B`/`-T`/`-6D`/`-6C`/`-4`/`-Z`/
  `-9`/`-3`/`-57`/`-A`), the 2026-06-10 ADRs *Throttle crashloop `model_load`
  failure spam …* (ATO-130/133) and *Fix the two real model-load bugs …*
  (ATO-124/125), the 2026-06-09 ADR *Add zero-PII Sentry crash/error tracking …*
  (ATO-113), files:
  [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/commands.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/commands.rs),
  [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/error.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/error.rs)
  (`from_exit_status`, `is_crash_exit`),
  [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/path.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/path.rs)
  (`is_split_gguf_name`), the mirror trio under
  [`tauri-plugin-llamacpp`](src-tauri/plugins/tauri-plugin-llamacpp/src/error.rs),
  [`src-tauri/plugins/tauri-plugin-hardware/src/vendor/amd.rs`](src-tauri/plugins/tauri-plugin-hardware/src/vendor/amd.rs),
  [`src-tauri/src/core/server/proxy.rs`](src-tauri/src/core/server/proxy.rs),
  [`src-tauri/src/core/telemetry/mod.rs`](src-tauri/src/core/telemetry/mod.rs)
  (`is_duplicate_event`),
  [`web-app/src/lib/telemetry.ts`](web-app/src/lib/telemetry.ts)
  (`shouldCaptureModelLoadSentry`, `isRecoverableModelLoadCode`),
  [`web-app/src/utils/switchModel.ts`](web-app/src/utils/switchModel.ts)
  (`shouldAttemptAutoStart`),
  [`web-app/src/containers/ChatInput.tsx`](web-app/src/containers/ChatInput.tsx).

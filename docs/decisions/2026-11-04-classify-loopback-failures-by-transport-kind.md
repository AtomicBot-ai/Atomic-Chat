---
date: 2026-11-04
title: 'Classify loopback chat failures by transport kind, and report what the engine says on load'
---

# 2026-11-04 — Classify loopback chat failures by transport kind, and report what the engine says on load

- **Context:** `classifyChatFailure` matched English substrings of the error
  text. The same "engine not listening" was `model_unreachable` on macOS
  (`os error 61`), `network` on English Windows (`os error 10061`), `unknown`
  on localized Windows, and `aborted` for 10053 ("connection was aborted").
  Repeat failures of one model and kind were dropped for 5 minutes, and every
  error was followed by a fake `success` on a freshly minted turn (the AI SDK
  calls `onFinish({isError:true})` after `onError`). Error events had no
  timing, and `model_load` failures carried only a stderr tail. As a result the
  handoff of 2026-11-03 read Windows as failing twice as often per user, while
  per response Windows (6.3%) was below macOS (8.0%).
- **Decision:** Rust prefixes loopback transport errors with
  `[transport:<kind>]` (`connect_refused`, `connect_timeout`,
  `connection_reset`, `body_eof`, `idle_timeout`, `request_failed`;
  `web-app/src/lib/transport-error.ts`). For local providers the classifier maps
  them to the new `error_kind` values `engine_unreachable` and
  `engine_exited`; remote providers keep `network` / `timeout`; untagged text
  falls back to OS error codes. Responses are deduplicated by `turn_id` only, an
  error-finished step never reports `success`, each attempt has an
  `attempt_id`, and error events carry `phase`, `ttft_ms`, `total_duration_ms`
  and `output_chunk_count`. `model_load` failures add the core's
  `atomic-core-diag` line as `exit_code`, `startup_stage`, `ran_backend`,
  `engine_build`, `fallback_*`, `empty_stderr`; loads get a `load_id` that the
  next `chat_request_sent` carries as `last_load_id`. `gpu_compute_capability`
  replaces the misnamed `cuda_runtime_version` (kept one release). Each disk tag
  is its own download `failure_reason`, `disk_fs_limit` included. Analytics are
  flushed on `app-shutting-down` and `pagehide`. `telemetry_schema` is 4.
- **Consequences:** Compare errors per attempt, not "ever saw an error" per
  user. Schema-4 `network` no longer includes a dead local engine, so trends
  across the bump need `telemetry_schema` in the breakdown. Automatic retries are
  `source: 'auto_retry'`.
- **Owner:** `team`
- **Links:** `web-app/src/lib/telemetry.ts` (`classifyChatFailure`),
  `web-app/src/lib/chat-telemetry.ts`, `web-app/src/lib/load-diag.ts`,
  `web-app/src/lib/telemetry-queue.ts`, `src-tauri/src/core/http.rs`
  (`classify_transport`).

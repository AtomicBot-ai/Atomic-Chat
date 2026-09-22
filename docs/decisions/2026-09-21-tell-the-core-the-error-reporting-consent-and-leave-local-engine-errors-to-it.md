---
date: 2026-09-21
title: "Tell the core the error-reporting consent, and leave local engine errors to it"
---

# 2026-09-21 — Tell the core the error-reporting consent, and leave local engine errors to it

- **Context:**
  - With `atomic-chat-core` owning the backend, the Rust `log::error!` bridge into `atomic-chat-desktop` no longer sees backend failures.
  - The core now reports its own crashes, failed loads, engine crashes and compute errors to its own Sentry project (core ADR `2026-09-21-report-core-errors-to-its-own-sentry-project`). It reports only under the app's `productAnalytic` consent, with the app's anonymous user and zero-PII tags, and it has no way to read any of them.
  - The web app already captured local model-load failures in `switchModel.ts` (ATO-113). Every such failure would now be counted twice.
- **Decision:**
  1. The Rust telemetry commands keep what they learn (`telemetry/core_state.rs`) and tell the attached core with `PUT /atomic/v1/telemetry`. This happens:
     - on every `set_telemetry_consent`, `set_telemetry_context` and `set_telemetry_user`;
     - on every core snapshot (attach and relaunch), next to the inspector state.

     The push never starts a core (`AtomicCoreClient::call_attached`).
  2. The core is launched with `daemon --telemetry on|off`, taken from the Rust gate. The gate stays on until the webview reconciles the persisted value, which is the window Rust panics already have.
  3. `switchModel.ts` captures model-load failures for cloud providers only; local engine failures are the core's.
- **Consequences:**
  - Engine failures arrive in `atomic-chat-core`, with the engine's context, from every caller: the UI, the Local API, Remote/LAN and the CLI.
  - The frontend project keeps cloud loads, downloads and context overflow.
  - `--telemetry` needs a core that knows the flag. Core 0.3.0 does, and the pin is already 0.3.0.
  - The wire is pinned by `tests/fixtures/core-contracts/telemetry/` (`dump_fixtures` in `atomic_core/telemetry.rs`), replayed in the core, and by `live_tests::the_core_reports_errors_only_under_the_consent_the_app_gives_it`.
- **Owner:** team.
- **Links:**
  - `src-tauri/src/core/telemetry/{commands,core_state}.rs`, `src-tauri/src/core/atomic_core/{launch,telemetry,commands}.rs`, `web-app/src/utils/switchModel.ts`.
  - Supersedes, for local providers only, the model-load capture of `2026-06-09-add-zero-pii-sentry-crash-error-tracking-to-both-the-react.md`.

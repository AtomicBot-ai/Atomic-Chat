---
date: 2026-09-19
title: "Ask the core before concluding a session does not exist"
---

# 2026-09-19 — Ask the core before concluding a session does not exist

- **Context:** The webview asks Rust where a local model is served (`resolve_local_session`), and Rust answers from a mirror of the core's sessions kept by the core's event stream. Right after a new core generation — the core crashed and the supervisor started another — that stream is still being re-established. A model loaded in that window has a session in the core whose `session:started` event nobody heard. The webview loaded the model (the load asks the core directly and succeeded), looked the session up, got nothing, and the user saw "Failed to create model: No running session found" with a Retry. Seen once in about 25 full runs of `tests/e2e/desktop/recovery.spec.ts`.
- **Decision:** A lookup that misses refreshes the mirror from the core's snapshot (`atomic_core::commands::refresh_sessions`, the same operation as the `atomic_core_snapshot` command) and looks again before answering "not loaded".
- **Consequences:** One extra loopback round trip on a miss, none on a hit. A model that really is not loaded is still reported as such. Fixed by reading the mechanism, not by a reproduction: the race is too rare to show on demand, so the evidence is that the recovery scenario stops failing this way.
- **Owner:** team
- **Links:** `src-tauri/src/core/sessions/mod.rs`, `src-tauri/src/core/atomic_core/commands.rs`, `web-app/src/lib/model-factory.ts`, `tests/e2e/desktop/recovery.spec.ts`

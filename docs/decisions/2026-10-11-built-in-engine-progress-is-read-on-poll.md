---
date: 2026-10-11
title: "Built-in engine progress is read on poll, not streamed as events"
---

# 2026-10-11 — Built-in engine progress is read on poll, not streamed as events

- **Context:** The built-in engine (`stable-diffusion.cpp`) reports only a job's
  status and queue position over HTTP. Its real step progress lives in its
  stdout progress bar, which Rust was already parsing (`supervisor.rs`) but only
  logging. The plan for wiring that parser to the frontend assumed both
  `features.progress` *and* `features.events` would flip to `true`, with a new
  `subscribe()` stream. An events-first stream, however, has no completion
  signal: the engine's stdout goes quiet when a job finishes, so the job manager
  would always wait out its 15-second silence watchdog before polling the
  terminal state — every job, every time.
- **Decision:** Rust emits each parsed step as a `media-engine-progress` Tauri
  event, and the built-in adapter reads it on poll only. `features.progress` is
  `true`; `features.events` stays `false` and there is no `subscribe()`. This
  matches the existing remote-adapter pattern (Replicate reports progress via
  poll, `events: false`), keeps poll as the terminal-state source, and leaves the
  15-second watchdog out of the local path.
- **Consequences:** Progress updates arrive at poll intervals (1–10 s backoff)
  rather than continuously, which is fine for a progress bar and indistinguishable
  from the remote adapters. No job can get stuck 15 seconds past completion. The
  single `media-engine-progress` event is global because the engine runs one job
  at a time; `submit()` resets the tracked step for each new job.
- **Owner:** @walladanger
- **Links:** `src-tauri/src/core/media/supervisor.rs`, `src-tauri/src/core/media/runtime.rs`,
  `web-app/src/services/media/adapters/builtinEngine.ts`,
  `web-app/src/services/media/jobManager.ts` (`MEDIA_SUBSCRIBE_SILENCE_MS`).

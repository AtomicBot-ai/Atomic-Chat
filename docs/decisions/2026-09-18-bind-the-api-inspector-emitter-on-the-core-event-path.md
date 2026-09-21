---
date: 2026-09-18
title: "Bind the API inspector's emitter on the core event path"
---

# 2026-09-18 — Bind the API inspector's emitter on the core event path

- **Context:** The API page's request log is fed by `RequestInspector`, which keeps a ring of records and delivers live events to the webview through an emitter bound with `attach(app)`. The only caller of `attach` was `LegacyOwner::start`, the start of the app's own proxy. Since the core serves the Local API, that start does not run: core `api:request` events reached the ring (`ingest_core_event`), but every delivery found no emitter and was counted in `dropped_events`. The page showed a request only after being reopened or refreshed, which hydrates from the ring. Found by `tests/e2e/desktop/api-inspector.spec.ts`; the lower-layer tests inject a sink and could not see it.
- **Decision:** `atomic_core::api_requests::ingest` binds the emitter before handing the event to the inspector. `attach` is a `OnceLock::set`, so this is idempotent and the legacy path keeps working unchanged.
- **Consequences:** Requests appear on the open page as they start, progress and finish. The binding happens on the first core event rather than at setup, which is early enough: nothing is recorded before the page subscribes. Covered end to end only; a unit test would need an `AppState` fixture that does not exist yet.
- **Owner:** team
- **Links:** `src-tauri/src/core/atomic_core/api_requests.rs`, `src-tauri/src/core/server/request_inspector.rs`, `tests/e2e/desktop/api-inspector.spec.ts`

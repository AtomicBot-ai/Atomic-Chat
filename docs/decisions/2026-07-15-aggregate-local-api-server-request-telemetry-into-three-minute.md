---
date: 2026-07-15
title: "Aggregate Local API Server request telemetry into three-minute summaries (ATO-297)"
---

# 2026-07-15 — Aggregate Local API Server request telemetry into three-minute summaries (ATO-297)

- **Context:** `api_server_request` emitted one PostHog event for every
 eligible Local API Server request and accounted for most analytics volume.
 The raw stream exceeded the useful granularity for product dashboards while
 consuming the project event quota.
- **Decision:** Accumulate eligible request observations in Rust for fixed
 180-second windows owned by each Local API Server run. Emit one
 `api_server_session_summary` for every non-empty window with request/status
 totals, latency sum/average/max, stream/fallback/OOM/context-overflow counts,
 deterministic endpoint/method/backend/provider/status/upstream-status/error
 breakdowns, and distinct model ids. The timer starts only after a successful
 bind. Server stop and normal app exit stop the Hyper task and await a final
 partial-window flush. Keep the pre-bind `server_bind_failed` signal immediate
 on the legacy request channel because it cannot belong to a server window.
- **Consequences:** Normal API telemetry volume is bounded by active
 three-minute windows instead of request rate. Dashboards must migrate from
 counting `api_server_request` rows to summing fields and breakdown values on
 `api_server_session_summary`. Per-request timing and ordering are
 intentionally discarded; aggregate diagnostic dimensions remain available.
 Empty windows emit nothing, and a final non-empty partial window survives
 server stop or normal application exit.
- **Owner:** team.
- **Links:** [ATO-297](https://linear.app/atomicchat/issue/ATO-297),
 [`src-tauri/src/core/server/api_request_analytics.rs`](src-tauri/src/core/server/api_request_analytics.rs),
 [`src-tauri/src/core/server/proxy.rs`](src-tauri/src/core/server/proxy.rs),
 [`web-app/src/providers/AnalyticProvider.tsx`](web-app/src/providers/AnalyticProvider.tsx),
 [`web-app/src/types/analytics.ts`](web-app/src/types/analytics.ts).

---

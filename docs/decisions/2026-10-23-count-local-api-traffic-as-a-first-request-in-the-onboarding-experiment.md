---
date: 2026-10-23
title: "Count Local API traffic as a first request in the onboarding experiment"
---

# 2026-10-23 — Count Local API traffic as a first request in the onboarding experiment

- **Context:** `2026-10-23-split-new-installs-into-three-onboarding-cohorts.md` left open whether a request that an agent or app sends through the Local API server counts as an install's first request, and named `api_server_request` as the event for it. On desktop that event never arrives. It comes from the app's proxy (`src-tauri/src/core/server/proxy.rs`), and on desktop the core serves `/v1`, so the proxy sees no traffic. The core reports each request to the app (`src-tauri/src/core/atomic_core/api_requests.rs`). The app sends `api_server_session_summary` for every three-minute window that had at least one request (`request_count > 0`). It never sends a summary for an empty window.
- **Decision:** A first request is a first chat turn or a first Local API request.
  - In PostHog this is one action: `chat_request_sent`, or `api_server_session_summary` (desktop), or `api_server_request` (mobile proxy).
  - The funnel and retention for `onboarding_experiment = onboarding_v1` use that action as the request step, broken down by `onboarding_variant`.
  - No new event is added; all three already carry the cohort as super-properties.
- **Consequences:**
  - On desktop, Local API traffic is timed to its three-minute window, not to the exact request. This is fine for a funnel measured in days.
  - Any endpoint counts, so `GET /v1/models` from an agent setting up counts too. To count inference only, filter the summary on `endpoint_counts` with HogQL (`chat/completions`, `messages`, `responses`).
  - Traffic is reported only while Atomic Chat is open. That is always the case on desktop, because the app hosts the server.
- **Owner:** team.
- **Links:** `web-app/src/providers/AnalyticProvider.tsx` (forwards both channels to PostHog), `src-tauri/src/core/server/api_request_analytics.rs` (`ApiRequestSummary`), `web-app/src/lib/onboarding/experiment.ts`.

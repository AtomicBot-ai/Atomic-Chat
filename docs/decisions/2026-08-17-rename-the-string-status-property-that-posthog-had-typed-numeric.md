---
date: 2026-08-17
title: "Rename the string `status` property that PostHog had globally typed numeric, which silently hid ~63k events"
---

# 2026-08-17 — Rename the string `status` property that PostHog had globally typed numeric, which silently hid ~63k events

- **Context:** Three dashboards carried notes describing an apparent instrumentation bug — "`model_load.status` is currently empty, so failure = error_code present" (Models & Errors, ~10 Jun) and "`backend_step_resolved.status` is not populated (instrumentation bug)" (Onboarding Funnel, ~3 Jul). Both were wrong, and both survived six weeks and roughly ten releases because a note in a dashboard description is not a ticket, and diagnosing it needed someone who could read both the emitting code and the ingested rows.

  PostHog assigns a property **type globally per project**, not per event, from the values it first observes. `api_server_request.status` is an HTTP status code — 134k numeric events — so the project-wide type for `status` became numeric. Every other event sending a *string* `status` still had the value stored in the raw JSON, but `properties.status` resolved to null in queries, breakdowns and the UI. `JSONExtractRaw(properties, 'status')` returned the values intact the whole time.

  Scope of the loss, measured at the time of the fix: `model_load` ~42.4k events, `model_download` ~20.4k, `backend_step_resolved` ~190 — about 63k events whose success/failure signal was unreadable. Recovering it exposed a 30-day model-load failure rate of **22.6%** (32,840 success / 9,608 failed) touching **1,989 of 3,584 devices**, led by `LLAMA_CPP_PROCESS_ERROR` (907 devices) and `MODEL_ARCH_NOT_SUPPORTED` (673) — a headline reliability number nobody could see.

- **Decision:** Rename the colliding property per event rather than reusing one shared replacement: `model_load.load_status`, `model_download.download_status`, `backend_step_resolved.step_status`. `api_server_request.status` keeps the name and the numeric type — it is the legitimate owner. Event-specific names are deliberately chosen over a shared `result_status`, because a generic shared name is exactly what caused this.

  Historical data is not migrated. Three `RECOVERED` HogQL tiles read `coalesce(nullIf(JSONExtractString(properties,'status'),''), properties.<new_name>)` so each chart spans the rename in one query, and the misdiagnosis notes on both dashboards were replaced with the real explanation.

  Before shipping the new `chat_response_received` / onboarding events, all 41 of their property names were audited against observed value types across 45 days of data. Only `status` collided; `model_id`, `source`, `backend`, `provider`, `error_kind`, `format` are consistently string, `attachment_count`, `duration_ms`, `http_status`, `size_gb`, `detected_count` consistently numeric, `had_any_model` boolean, and the rest were unused. That audit is the practice worth repeating, not a one-off.

- **Consequences:** Queries and breakdowns on load/download/backend-step outcomes work from the next release. Existing saved insights that filter on `status` for these three events keep returning nothing — they were already returning nothing, so nothing regresses, but they should be repointed. The four emit sites carry an inline comment naming the cause, because the obvious "cleanup" is to rename them back.

  Not done: there is no automated guard against a future collision. The emit sites call `posthog.capture` directly rather than going through a shared wrapper, so a reserved-name check would need a small refactor — worth doing, tracked separately. Until then the defence is the inline comments and this record.

  Also unaddressed: a live React Native client (377 users / 90 days) shares this PostHog project with the desktop app under a separate event taxonomy (`message_sent`, `response_received`, `generation_started`). Any project-wide metric silently mixes two products, and it is the same class of shared-namespace hazard as this bug.

- **Owner:** `team`
- **Links:** `web-app/src/utils/switchModel.ts`, `web-app/src/containers/DownloadManegement.tsx`, `web-app/src/services/models/default.ts`, `web-app/src/containers/SetupBackendStep.tsx`. Dashboards: [Models & Errors](https://us.posthog.com/project/363713/dashboard/1693890), [Onboarding Funnel & Analysis](https://us.posthog.com/project/363713/dashboard/1794916). Companion record: [track LLM response outcomes](2026-08-17-track-llm-response-outcomes-and-close-onboarding-funnel-gaps.md).

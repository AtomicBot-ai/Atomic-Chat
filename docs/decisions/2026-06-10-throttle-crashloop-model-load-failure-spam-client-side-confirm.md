---
date: 2026-06-10
title: "Throttle crashloop `model_load` failure spam client-side; confirm `model_load.status` / api 404-noise are already-fixed-pending-rollout, not code bugs (ATO-130: ATO-133 + ATO-131 + ATO-132)"
---

# 2026-06-10 — Throttle crashloop `model_load` failure spam client-side; confirm `model_load.status` / api 404-noise are already-fixed-pending-rollout, not code bugs (ATO-130: ATO-133 + ATO-131 + ATO-132)

- **Context:** Epic [ATO-130](https://linear.app/atomicchat/issue/ATO-130)
 reported three data-quality defects in the new PostHog telemetry (the
 `model_load` / hardware super-prop / `api_server_request` work from the
 2026-06-09 ADRs *Extend the PostHog telemetry channel …* / ATO-108):
 (1) [ATO-131](https://linear.app/atomicchat/issue/ATO-131) `model_load.status`
 always `None` (19 788 events / 72 devices over 14d); (2)
 [ATO-132](https://linear.app/atomicchat/issue/ATO-132) `api_server_request`
 404-noise not removed (~202k `not_found`) + new `error_kind`s nearly empty;
 (3) [ATO-133](https://linear.app/atomicchat/issue/ATO-133) crashloop devices
 spamming thousands of `model_load` events (top: 4504 / 3700 / 3458 / 1517 /
 1062). Investigation correlated the queries (run 2026-06-10) against the
 release timeline: **the new telemetry first shipped in `v1.1.105`
 (2026-06-09 ~17:52 MSK) and `v1.1.106` (18:27)** — i.e. < 1 day before the
 14-day-window queries, with rollout barely started (~87 / 2502 devices carry
 `gpu_vendor`). Code audit at HEAD:
 - **ATO-132 is already fixed in code.** [`proxy.rs`](src-tauri/src/core/server/proxy.rs)
 sets `skip_emit = true` on the catch-all 404 (the `_ =>` arm) and on
 `GET /v1/models` polling, and splits `upstream` into
 `local_model_error` / `remote_provider_error` / `local_model_unreachable` /
 `proxy_internal` / `server_bind_failed` via `upstream_error_kind` /
 `unreachable_error_kind`. The 202k `not_found` + empty new kinds are the
 **pre-`v1.1.105` population**; this self-resolves as `v1.1.106` rolls out. No
 code change.
 - **ATO-131 is not a code defect.** The sole emitter
 ([`switchModel.ts::emitModelLoad`](web-app/src/utils/switchModel.ts), added
 in `df7cc39d3`, in `v1.1.105`) sets `status: 'success' | 'failed'` in the
 captured props; the PostHog `sanitize_properties` denylist in
 [`AnalyticProvider.tsx`](web-app/src/providers/AnalyticProvider.tsx) does
 **not** contain `status`; other props from the same `capture` call (model_id
 etc.) arrive fine, ruling out an init/instance problem; and PostHog does not
 reserve a top-level event property named `status`. No code defect was
 identifiable from static analysis — fabricating a "fix" was rejected.
 Recommended resolution is a filtered re-query (`app_version >= 1.1.105`,
 tight window) to confirm whether it is a dirty-window artifact or a
 PostHog-side ingestion/materialization quirk; renaming `status` →
 `load_status` was rejected because it would break the existing dashboards
 that GROUP BY `properties.status`.
- **Decision:** Implement only the one defect that genuinely needs code —
 ATO-133. Add a client-side throttle for **repeated identical `model_load`
 failures**, following the existing dedup-helper pattern in
 [`lib/telemetry.ts`](web-app/src/lib/telemetry.ts) (`finalizeDownloadOnce`,
 the download-dedup trio): new `shouldEmitModelLoadFailure(modelId, errorCode)`
 keyed on `${modelId}::${errorCode ?? 'unknown'}`, suppressing duplicates
 within a 5-minute window (`MODEL_LOAD_FAILURE_THROTTLE_MS`, Map capped at 500
 keys). `emitModelLoad` computes `error_code` up front and returns early when
 the throttle says skip; **successes are never throttled** (they are not the
 spam source and are individually valuable). This is the ticket's option (a)
 ("don't send the same fail more than once per N minutes per device"); the
 attempt-counter alternative was deliberately not taken (pure throttle is
 minimal and the dashboards are already device-weighted, so losing per-burst
 magnitude is acceptable).
- **Consequences:**
 - A device stuck in a load crashloop now emits at most one `model_load`
 failure per (model, error_code) per 5 min instead of one per retry, so
 event-weighted metrics stop being dominated by a handful of stuck machines.
 The throttle is per-process in-memory (resets on app restart), which is fine
 — it targets tight retry loops, not cross-session dedup.
 - **Lossy by design:** exact retry counts within a window are not preserved
 (accepted per ticket). The underlying *product* bug — why those machines
 loop — is **not** addressed here (separate investigation noted on ATO-133).
 - **ATO-131 / ATO-132 ship no code** from this session: ATO-132 awaits
 rollout; ATO-131 awaits a filtered re-query to decide if any action is even
 warranted. Scope: web-app only (two files), no Rust / IPC / schema / on-disk
 change. Lint-clean on both edited files.
- **Owner:** team.
- **Links:** [ATO-130](https://linear.app/atomicchat/issue/ATO-130),
 [ATO-131](https://linear.app/atomicchat/issue/ATO-131),
 [ATO-132](https://linear.app/atomicchat/issue/ATO-132),
 [ATO-133](https://linear.app/atomicchat/issue/ATO-133),
 [ATO-112](https://linear.app/atomicchat/issue/ATO-112), the 2026-06-09 ADRs
 *Extend the PostHog telemetry channel …* and *Add zero-PII Sentry …*, files:
 [`web-app/src/lib/telemetry.ts`](web-app/src/lib/telemetry.ts)
 (`shouldEmitModelLoadFailure`),
 [`web-app/src/utils/switchModel.ts`](web-app/src/utils/switchModel.ts)
 (`emitModelLoad`).

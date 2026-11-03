---
date: 2026-10-28
title: "Wait for analytics readiness and recover onboarding assignments"
---

# 2026-10-28 — Wait for analytics readiness and recover onboarding assignments

- **Context:** The onboarding experiment had more than a thousand recorded person assignments but no `onboarding_cohort_assigned` events, so all three insights on dashboard 2249870 were empty. The installed `posthog-js` 1.255.1 returns `true` from `has_opted_in_capturing()` before initialization while `capture()` silently drops the event. Our queue mistook consent for readiness, and its tests incorrectly modeled the pre-init call as throwing.
- **Decision:**
  - Buffer startup events until `AnalyticProvider` explicitly flushes after identity restoration, consent and super-properties. Do not derive readiness from SDK consent. Re-arm the buffer on a later initialization. Disabled analytics discards pending activity, and a cancelled initialization cannot opt in or flush it.
  - Persist the assignment before React mounts, and capture it only from the ready provider. Use its original `assignedAt` timestamp and send immediately. Persist `assignmentCaptured` only when the SDK accepts the capture; declined captures and exceptions remain pending for a later launch. Existing cohorts without that marker recover the missing event on upgrade. An unknown or invalid assignment time is never replaced with the current time or the Unix epoch.
  - Keep the original cohort and analytics identity across factory reset. QA can select the full flow with `FORCE_ONBOARDING_VARIANT=full make dev-fresh`; shipped installations are not re-randomized.
  - Recover the existing dashboard directly from the current person's `$set_once` properties `onboarding_experiment`, `onboarding_variant` and `onboarding_assigned_at`, joined by person ID to observed requests. This also covers old builds that continue to lose the entry event. No synthetic historical events are ingested. Preserve the existing insight IDs and the test-account exclusion (cohort 236342).
  - Reuse action 360381, `Target action: message or local API`, for qualifying requests. The dashboard date selector chooses assignment dates; follow-up requests are observed through the present. Conversion uses the seven days after the original assignment and separates provisional results from completed windows. Daily retention uses completed UTC calendar days only; future/unobserved days are null rather than zero. Group attribution uses the first person assignment, not a later event's possibly redrawn variant.
- **Consequences:** Telemetry schema 3 identifies the corrected startup path. The SDK-acceptance marker is not a delivery receipt; transport delivery still relies on PostHog. Dashboard recovery does not depend on that one event's delivery. Only assignments actually reported to PostHog can be recovered, and absent request events cannot be reconstructed. The recovered metrics have no approved Data Catalog definition. SQL is necessary because the historical entry time lives on the person, not an event. If project test-account rules change, update the SQL exclusion too.
- **Validation:** A regression uses the real uninitialized SDK; queue tests cover reinitialization and discarding opted-out activity. Assignment tests cover delayed capture, original timestamps, retry after a declined capture or exception, invalid timestamps and persistence across launches. The repaired dashboard queries are executed against the live project and checked with an assignment-date override. Lint, type checking, quality/contracts, the full application and extension test suites, critical coverage floors and the platform-supported Rust suites passed.
- **Owner:** team.
- **Links:** [Onboarding dashboard](https://us.posthog.com/project/363713/dashboard/2249870), `web-app/src/lib/telemetry-queue.ts`, `web-app/src/lib/onboarding/experiment.ts`, `web-app/src/providers/AnalyticProvider.tsx`, `web-app/src/lib/__tests__/telemetry-startup.test.ts`.

<!--
Supersedes the capture timing and event-only dashboard assumptions in:
2026-10-23-split-new-installs-into-three-onboarding-cohorts.md
-->

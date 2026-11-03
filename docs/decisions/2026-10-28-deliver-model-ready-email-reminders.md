---
date: 2026-10-28
title: "Deliver the wait screen's model-ready email reminder"
---

# 2026-10-28 — Deliver the wait screen's model-ready email reminder

- **Context:** The wait screen's email form was hidden because it only recorded
  a telemetry event. The reminder API is now available at `https://api.atomic.chat`.
- **Decision:** Enable the form with explicit one-email consent. Generate and
  persist a cryptographically random install bearer on first submission. Register
  the address with `PUT /v1/reminders` and show success only after its `204` and
  local persistence succeed. Persist the token and chosen model reference, never
  the address. `OnboardingRuntime` observes that model's availability on every
  route and after relaunch, then calls `POST /v1/reminders/notify`.
- **Consequences:** Leaving setup or changing the selected model cannot lose a
  registered reminder. Network/server errors retry the idempotent notify with
  persisted backoff; `429` honors `Retry-After`. `202` stops retries, and `404`
  expires the intent without another PUT, preserving the server's last-registration
  rule across installations. Registration errors require an explicit retry and
  keep the entered address only in the form. Both writes share a queue and have
  a deadline. Local intents expire after 30 days, matching server retention.
  Closing the app pauses readiness reporting until the next launch. Factory reset
  clears the token and intent. The API remains a one-off reminder service with
  a per-address 24-hour cooldown; it does not verify ownership of the address.
  A mail already in delivery cannot be recalled by a new registration.
- **Owner:** `team`.
- **Links:** `web-app/src/services/email-reminders.ts`,
  `web-app/src/stores/email-reminder-store.ts`,
  `web-app/src/hooks/useEmailReminderSync.ts`,
  `web-app/src/containers/onboarding/steps/WaitStep.tsx`.

<!--
Supersedes: 2026-10-27-hide-the-email-reminder-until-it-is-delivered.md
-->

---
date: 2026-10-27
title: "Hide the wait screen's email reminder until it is delivered"
---

# 2026-10-27 — Hide the wait screen's email reminder until it is delivered

- **Context:** The first-run wait screen (2026-10-26) shipped the prototype's
  "Prefer to come back later?" form as UI only: it said "Reminder set." while
  the address was neither kept nor sent. The reminder API
  (`atomic-chat-backend`) exists but is not deployed, and the app does not
  call it yet. That record required wiring the form or hiding it before a
  release.
- **Decision:** For this release the form is hidden behind
  `EMAIL_REMINDER_OFFERED` (`containers/onboarding/steps/waitAvailability.ts`,
  `false`). The wait screen keeps Explore the app, Atomic Mines and the ready
  state. The form, its strings and its styles stay in place and are tested
  with the flag on.
- **Consequences:** No screen promises an email nobody sends.
  `onboarding_reminder_requested` is not sent while the form is hidden, so
  there is no data on demand for reminders yet. Turning the flag on comes
  with the app wiring: a persisted install token, `PUT /v1/reminders` on
  submit, `POST /v1/reminders/notify` when the chat download completes, and
  consent copy.
- **Owner:** `team`.
- **Links:** `web-app/src/containers/onboarding/steps/WaitStep.tsx`,
  `web-app/src/containers/onboarding/steps/waitAvailability.ts`,
  `2026-10-26-show-a-wait-screen-while-the-first-model-downloads.md`.

<!--
Supersedes: 2026-10-26-show-a-wait-screen-while-the-first-model-downloads.md (in part)
-->

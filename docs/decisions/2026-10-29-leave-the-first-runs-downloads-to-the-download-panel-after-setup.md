---
date: 2026-10-29
title: "Leave the first run's downloads to the download panel after setup"
---

# 2026-10-29 — Leave the first run's downloads to the download panel after setup

- **Context:** After a handoff to the chat the first-run handoff panel followed
  the run's downloads with its own strip, and the global download panel left
  those task ids out but listed everything else. Whenever both had something
  to show, the corner held two download cards of two different looks at once.
  The user asked for only the download panel's card after setup.
- **Decision:** After setup the download panel lists the run's downloads like
  any other, and the handoff panel stays away while one is queued, running or
  paused. It shows for a download that was interrupted, with Retry, because
  the download panel drops a failed row and the run's queue waits for it; and,
  as before, to say the model is ready or to offer the way back to setup, until
  dismissed.
- **Consequences:** One download card in the corner after setup; pause, resume
  and cancel of the run's downloads come from the download panel's row. The
  "N more queued" line of the strip is gone after setup: a media job appears in
  the panel when it starts. The setup screen keeps its strip. The model picker
  still reads the chat model's progress and offers Retry.
- **Owner:** `team`.
- **Links:** `web-app/src/lib/onboarding/jobs.ts` (`handoffPanelContent`),
  `containers/onboarding/OnboardingRuntime.tsx`,
  `containers/DownloadManegement.tsx`.

<!--
Supersedes: 2026-10-22-replace-the-welcome-screen-with-a-full-screen-first-run-flow.md (in part: the panel following the run's downloads after a chat handoff)
-->

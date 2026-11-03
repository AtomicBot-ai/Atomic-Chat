---
date: 2026-10-26
title: 'Show a wait screen while the first model downloads'
---

# 2026-10-26 — Show a wait screen while the first model downloads

- **Context:** Everyday use on the purpose step handed off to the chat at
  once, even with the chosen model still downloading, so a new user landed on
  an empty chat with nothing to do. The prototype has a wait step for that
  moment ("Good things are downloading.") with Atomic Mines and an email
  reminder; the 2026-10-22 port left it out, and feedback on 2.2.26 asked for
  it back.
- **Decision:** `wait` is a branch of purpose, as `server` is: under the
  purpose counter, Back returns to purpose, Continue never reaches it.
  Everyday use goes there when the chosen model is a download that cannot
  answer yet (`waitsForChatModel`), else straight to the chat. The screen
  offers "Explore the app" (the chat handoff, the download carries on), the
  game, and the email form; once the model is ready it reads "Your model is
  ready." with "Start chatting". The email form is UI only for now: the
  address is neither stored nor sent, and only `onboarding_reminder_requested`
  (without the address) is reported.
- **Consequences:** `step_reached` and the per-step funnel gain `wait`;
  `onboarding_step_left` from purpose with `everyday` no longer always means
  the chat. New events: `onboarding_wait_game`, `onboarding_reminder_requested`.
  "Reminder set." promises an email nobody sends yet: before a release either
  wire delivery or hide the form. The `model_only` variant still hands off
  after the model step, without the wait screen, so the experiment's arms are
  unchanged.
- **Owner:** `team`.
- **Links:** `web-app/src/containers/onboarding/steps/WaitStep.tsx`,
  `web-app/src/containers/onboarding/steps/AtomicMines.tsx`,
  `web-app/src/lib/onboarding/mines.ts`, `web-app/src/lib/onboarding/jobs.ts`
  (`waitsForChatModel`), prototype `preview/onboarding/Onboarding.tsx` and
  `Mines.tsx`.

<!--
Supersedes: 2026-10-22-replace-the-welcome-screen-with-a-full-screen-first-run-flow.md (in part)
-->

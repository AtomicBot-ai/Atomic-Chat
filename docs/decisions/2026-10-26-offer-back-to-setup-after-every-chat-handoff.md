---
date: 2026-10-26
title: 'Offer Back to setup after every chat handoff, in the session that handed off'
---

# 2026-10-26 — Offer Back to setup after every chat handoff, in the session that handed off

- **Context:** After a handoff to the chat the panel showed only to follow
  downloads or to say the model was ready. Skip setup, a cloud-only run or a
  cancelled download left nothing to show, the run finished at once, and
  there was no way back into setup. The prototype shows the panel after
  every chat handoff, with "Back to setup" and "Dismiss" even when its strip
  is empty.
- **Decision:** `handoffPanelContent` has a third answer, `setup`: a chat
  handoff with nothing to follow and no model ready shows the panel with its
  links only, in the app session that handed off, until dismissed. It gives
  the corner to an update banner or the model reminder, as the ready note
  does. A later launch with nothing to follow still ends the run without it.
- **Consequences:** The run stays `handedOff` until Dismiss in that session.
  Desktop E2E's `skipOnboarding` dismisses the panel
  (`data-testid="onboarding-handoff-dismiss"`) so it covers nothing a
  scenario clicks next.
- **Owner:** `team`.
- **Links:** `web-app/src/lib/onboarding/jobs.ts`,
  `web-app/src/containers/onboarding/OnboardingRuntime.tsx`,
  `web-app/src/containers/onboarding/OnboardingHandoffPanel.tsx`,
  `tests/e2e/harness/chat.ts`, prototype `preview/onboarding/Onboarding.tsx`
  `FirstRunRuntime`.

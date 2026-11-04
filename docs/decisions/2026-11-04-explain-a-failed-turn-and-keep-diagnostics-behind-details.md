---
date: 2026-11-04
title: 'Explain a failed turn in words and keep the diagnostics behind Details'
---

# 2026-11-04 — Explain a failed turn in words and keep the diagnostics behind Details

- **Context:** The 2.3.4 design review (D7) asked to keep the readable
  "The model engine stopped" pattern for every chat error, to say when a
  settings change caused the restart, and to move raw diagnostics out of the
  way. In the QA run the user changed the context size while Qwen3.5 4B was
  answering; the reload cut the turn off and the card only said the engine
  stopped. Unclassified errors still showed raw text, sometimes JSON envelopes
  or stack traces.
- **Decision:** One `TurnErrorCard`, driven by a pure `summarizeTurnError`,
  renders every failed turn as a title, a readable sentence and one labelled
  recovery action. Where a readable sentence replaces the provider's text
  (engine gone, out of memory, auth, access, context), the raw text sits in a
  collapsed `<details>` region. An unclassified error keeps the provider's
  text as the body (it can carry links) unless it looks like a diagnostic — a
  `[transport:*]` tag, JSON, a stack trace, more than two lines or a very long
  text — which then goes behind Details under a generic sentence. Restarts that
  a settings change sets off (context size and Fit, other load-time options,
  engine settings, the DFlash toggle) are wrapped in `trackSettingsRestart`; a
  live engine-gone or unclassified local error first seen while such a restart
  runs, or within 15 s after it, reads "The model restarted after a settings
  change" with Retry.
- **Consequences:** The context-overflow actions are unchanged (Open engine
  settings / Shorten history / Increase Context Size). The restart marker is
  in memory only, so after a relaunch a stored failed turn shows the plain
  engine-stopped card. The automatic-retry shimmer still says the engine
  stopped. Not checked in the real app.
- **Owner:** `team`
- **Links:** `web-app/src/containers/TurnErrorCard.tsx`,
  `web-app/src/lib/turn-error-summary.ts`, `web-app/src/lib/settings-restart.ts`,
  `web-app/src/routes/threads/$threadId.tsx`,
  [Recover a failed local turn once](2026-11-04-recover-a-failed-local-turn-once.md).

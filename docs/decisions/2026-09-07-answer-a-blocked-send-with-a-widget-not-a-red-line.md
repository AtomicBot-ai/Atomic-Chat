---
date: 2026-09-07
title: "Answer a blocked send with a widget, not a red line"
---

# 2026-09-07 — Answer a blocked send with a widget, not a red line

- **Context:** Sending a message with no model selected produced
  `chat:selectModelToChat` — an inline red line under the composer that named
  the problem and offered no way to solve it. Three things made that worse than
  it looks. The Send button was not blocked, so the only way to learn about the
  state was to press it. The early `return` that produced the line sat in front
  of `captureChatRequest`, so the whole path emitted **no telemetry at all** and
  its size was unknown. And the state is not an edge case: `preloadModelOnStartup`
  is off by default and `main.tsx` clears the persisted selection on boot, so
  *every* cold launch starts here. The existing bottom-right nudge
  (`PromptOnboardingModel`) does not cover it — it arms only on onboarding's
  timeout exit, and its numbers (62.2 % activation for `download`, 64.3 % for
  `later`, 17.2 % for untouched) say it marks already-motivated users rather
  than converting anyone. Meanwhile segment D — 802 devices that saw no
  onboarding and had nothing — activates at 24.7 % in 24 h against 92.1 % for
  devices that got a model up on day one.

- **Decision:** One widget, opened at the moment of the blocked action, whose
  shape is decided by what is actually on the device (`lib/reply-model-gate.ts`):
  exactly one usable model → start it and say so, asking nothing; several →
  offer them, last used first; none → recommend the model the hardware tier
  already picks for onboarding's reminder. **Connect Cloud and Connect ChatGPT
  subscription sit beside all three branches**, not only the empty one — of 153
  users who connected a cloud key, 144 activated, with day-2 return 58.3 %
  against 36.7 %, so it is an equal alternative rather than a lifeboat. The
  typed message is never lost: it stays in the composer and is sent, unchanged,
  the moment something can answer — including after a multi-minute download,
  because the widget closes and the composer keeps waiting. Three events cover
  the path that had none: `reply_model_gate_shown` (branch + device context),
  `reply_model_gate_outcome` (which exit, how long it took) and
  `reply_model_gate_ready` (time to an answerable model, and whether the queued
  message went out).

- **Consequences:**
  - A connected cloud provider is one row standing for the provider, not its
    whole catalogue: an OpenRouter key would otherwise bury two local models
    under three hundred entries and turn a decision into a search. Choosing a
    different cloud model stays the model dropdown's job.
  - "Block Send in advance" is implemented as a *visibly distinct, explained*
    Send button (`data-needs-model`, secondary variant, tooltip) that stays
    clickable, because pressing it is how the user reaches the widget. A truly
    disabled button would state the problem and hide the cure — the failure this
    record exists to end.
  - `PromptOnboardingModel` is unchanged in behaviour but now shares
    `useRecommendedLocalModel` with the widget, so the app cannot recommend two
    different "recommended" models. The nudge itself is deliberately left in
    place; retiring it is a separate call.
  - `AddCloudProviderDialog` gained `initialProviderName` (so the named
    subscription button lands on the sign-in, not on a gallery) and
    `duringOnboarding` (so `provider_key_configured` can tell a key pasted in
    setup from one pasted at a blocked send). Both default to today's behaviour.
  - No property in the new events is named `status`: it is typed as a number
    globally in PostHog and a string written there is ingested as null.
  - Branching counts *readiness*, not just local models, so a user with a
    connected cloud provider and no local weights is offered what they already
    have instead of a 2 GB download.

- **Owner:** @mishaskvortsov

- **Links:** [ATO-453](https://linear.app/atomicchat/issue/ATO-453) (absorbs
  ATO-460); related ATO-452, ATO-461, ATO-462, ATO-463.
  `web-app/src/containers/ReplyModelGate.tsx`,
  `web-app/src/lib/reply-model-gate.ts`,
  `web-app/src/lib/reply-gate-telemetry.ts`,
  `web-app/src/hooks/useRecommendedLocalModel.ts`,
  `web-app/src/containers/ChatInput.tsx`.

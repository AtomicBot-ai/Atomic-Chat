---
date: 2026-10-22
title: "Replace the Welcome screen with a full-screen first-run flow"
---

# 2026-10-22 — Replace the Welcome screen with a full-screen first-run flow

- **Context:** First run was `SetupScreen`, an 1,850-line Welcome screen the
  home route drew in place of the composer: an optional GPU-backend step on
  Windows/Linux, then one model picker with cloud buttons, finished by the
  `setup-completed` flag. The approved interface prototype
  (`AtomicBot-ai/atomic-chat-interface-prototype`, `preview/onboarding/`) has a
  six-step flow instead, with branches for what the machine already has (a
  downloaded model, the Apple model) and what the user came for (chat, or a
  server for other tools). The product also wants to compare three cohorts in
  PostHog — no onboarding, Welcome → model, the full flow — on first-request
  rate and retention, so the flow has to be one that a variant can shorten.
- **Decision:** First run is a full-window route, `/onboarding`, rendered
  inside `AppLayout` (so downloads, analytics and the media stores keep
  running) without the navigation; the home route redirects there.
  - The steps are data (`lib/onboarding/steps.ts`): welcome, the Windows/Linux
    backend step, model, permissions, cloud, media, purpose, and server as a
    branch of purpose. A step is shown only when its availability hook has
    something to offer. `getOnboardingVariant()` returns `full`; the
    experiment adds variants as entries of `ONBOARDING_STEPS`.
  - The run (`stores/onboarding-store.ts`, `atomic-onboarding`) is persisted,
    so a relaunch — the backend step forces one — comes back to the same step
    with the same downloads.
  - Every exit goes through `handOffOnboarding` (`lib/onboarding/handoff.ts`):
    `setup-completed` keeps its meaning and its readers, the chat model is
    selected when it can answer, and `onboarding_completed` is sent once.
  - The model step lists models already in the library or found on disk
    first, preselected ("Use …"), then the tier's best fit and at most three
    curated picks this machine can run. Continue starts the download, which
    runs under the following steps. Image and video models queue behind the
    chat model and run one at a time (`OnboardingRuntime`,
    `lib/onboarding/media-jobs.ts`).
  - After a chat handoff a panel follows the run's downloads, with "Back to
    setup"; the model picker reads "Downloading NN%" until the model lands,
    and the model is selected then if nothing else was. A server handoff opens
    the real Server pages with step hints (`SetupGuideHint`), and Start waits
    for the model.
  - Permissions asks the OS for notifications and the microphone; "Files &
    folders" only explains, since macOS cannot pre-grant file access.
  - The colours follow the app theme: the prototype's palette in dark, theme
    tokens in light.
- **Consequences:**
  - Telemetry: `step_reached` (on `onboarding_completed`/`onboarding_abandoned`)
    takes every step id, so funnels filtering `step_reached = 'model'` miss
    users who got further. New: `onboarding_step_shown`/`onboarding_step_left`
    (the per-step funnel), `onboarding_variant` and `destination` on
    completion, `onboarding_permission`, `onboarding_media_queued`,
    `onboarding_purpose`, `onboarding_guide`. No longer sent:
    `setup_local_model_autostarted` and `exit_path: hub`.
  - Onboarding stylesheets open with Tailwind's layer-order statement: one
    of them loads before `index.css`, and a file whose first rule opened
    `@layer components` put that layer before `base` for the whole document.
  - Desktop E2E leaves the flow through `skipOnboarding`
    (`data-testid="onboarding-skip"`).
  - The Apple on-device row is wired but stays hidden while that provider is
    withdrawn (2026-09-30).
  - `PromptOnboardingModel` is dormant: nothing arms its reminder since
    ATO-452. It is left in place.
  - Partly supersedes: 2026-08-12 (found models are listed and preselected,
    not auto-started), 2026-09-16 (the flow hands off while the download
    runs; the panel and the picker follow it), 2026-08-19 (cloud is a step of
    its own), 2026-09-11 (the picks are capped and filtered by fit).
    2026-09-17 (Skip leaves the selection empty) still holds.
- **Owner:** team
- **Links:** `web-app/src/routes/onboarding.tsx`,
  `web-app/src/containers/onboarding/`, `web-app/src/lib/onboarding/`,
  `web-app/src/stores/onboarding-store.ts`,
  `web-app/src/lib/onboarding-telemetry.ts`,
  [Auto-start a model found on disk](2026-08-12-auto-start-a-model-found-on-disk-instead-of-showing-the-picker.md),
  [Stay on the Welcome screen until the download lands](2026-09-16-stay-on-the-welcome-screen-until-the-download-lands.md),
  [Let onboarding connect a cloud provider](2026-08-19-let-onboarding-connect-a-cloud-provider.md),
  [List the Hub picks under the onboarding offer](2026-09-11-list-the-hub-picks-under-the-onboarding-offer.md)

<!--
Supersedes (in part): 2026-08-12-auto-start-a-model-found-on-disk-instead-of-showing-the-picker.md,
2026-09-16-stay-on-the-welcome-screen-until-the-download-lands.md,
2026-08-19-let-onboarding-connect-a-cloud-provider.md,
2026-09-11-list-the-hub-picks-under-the-onboarding-offer.md
-->

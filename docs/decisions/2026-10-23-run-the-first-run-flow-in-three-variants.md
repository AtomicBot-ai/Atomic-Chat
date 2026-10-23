---
date: 2026-10-23
title: "Run the first-run flow in three variants: full, model only, none"
---

# 2026-10-23 — Run the first-run flow in three variants: full, model only, none

- **Context:** The first-run flow (2026-10-22) keeps its steps as data, but
  only `full` existed and `getOnboardingVariant()` always returned it. The
  onboarding experiment compares three cohorts on first-request rate and
  retention: no onboarding, Welcome → model, and the full flow. Each one has to
  exist, and be reviewable in a dev build, before any cohort is assigned.
- **Decision:** `OnboardingVariant` is `full | model_only | none`, each an entry
  of `ONBOARDING_STEPS` (`lib/onboarding/steps.ts`).
  - `model_only`: Welcome, then the Windows/Linux backend step wherever the full
    flow shows it, then the model. Continue past the model hands off to the
    chat, as the full flow does after its last step. The backend step stays
    because the model step offers and downloads for the backend it picked, and
    the two cohorts should differ only in what comes after the model.
  - `none`: no steps. `shouldEnterOnboarding` and `isOnboardingPending` return
    false for it, `FORCE_ONBOARDING` included, so `/` never redirects and
    `/onboarding` sends the user home. The home route sets `setup-completed`
    on arrival: the update banners, the backend download progress and the
    model-load snackbar that wait for it belong to this first run. The reply
    gate offers the first model when the user sends a message. On
    Windows/Linux, `StartupBackendCoordinator` moves llama.cpp to the detected
    GPU build without asking; a ROCm build still asks first, as it does for
    everyone.
  - A run keeps the variant it began with (`atomic-onboarding`).
    `getOnboardingVariant()` only chooses for a new run, and returns `full`
    until the experiment assigns cohorts.
  - Dev builds can pin a variant with `FORCE_ONBOARDING_VARIANT`, a Vite define
    that is read only under `tauri dev` (`IS_DEV`), for example
    `FORCE_ONBOARDING_VARIANT=model_only make dev-fresh`. A value that is not a
    variant is ignored, with a console warning.
- **Consequences:**
  - `onboarding_variant` on `onboarding_step_shown`, `onboarding_step_left` and
    `onboarding_completed` is the variant the run actually ran. The in-flight
    record carries it too, so `onboarding_abandoned` now has
    `onboarding_variant`. It is `null` for a record written by an earlier
    build.
  - A `none` install sends no onboarding events at all. Its cohort has to come
    from the experiment's own person property.
  - `app_opened.is_first_launch` is read once, before React mounts
    (`rememberFirstLaunch`). Without that, a `none` install has already marked
    setup done, and What's New has marked the version seen, by the time
    `app_opened` goes out (it waits for the hardware properties). The whole
    cohort would then have reported `false`.
  - `AppLayout` now picks its full-window branch from the page on screen
    (`isOnboardingOnScreen`, the router's matches), not from the location. The
    router moves the location before the new page is ready, so the setup
    screen used to remount beside the navigation during its own handoff. That
    re-opened the run, and a handoff with a download still running (Continue
    on the model in `model_only`, any later exit of the full flow) went
    straight back to `/onboarding`.
  - Not done here: random assignment, PostHog person and super properties,
    feature flags. That is the experiment task.
- **Owner:** team
- **Links:** `web-app/src/lib/onboarding/steps.ts`,
  `web-app/src/lib/onboarding.ts`, `web-app/src/routes/index.tsx`,
  `web-app/src/routes/onboarding.tsx`,
  `web-app/src/containers/onboarding/Onboarding.tsx`,
  `web-app/src/lib/onboarding-telemetry.ts`, `web-app/vite.config.ts`,
  `Makefile` (`dev-fresh`),
  [Replace the Welcome screen with a full-screen first-run flow](2026-10-22-replace-the-welcome-screen-with-a-full-screen-first-run-flow.md)

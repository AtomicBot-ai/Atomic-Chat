---
date: 2026-10-23
title: "Split new installs into three onboarding cohorts, drawn on the device and recorded in PostHog"
---

# 2026-10-23 — Split new installs into three onboarding cohorts, drawn on the device and recorded in PostHog

- **Context:** The first run now has three variants: `full`, `model_only` (Welcome → model) and `none` (no setup screen), see `2026-10-23-run-the-first-run-flow-in-three-variants.md`. Every shipped build still showed `full`. Product wants to run all three side by side for about three weeks and compare cohorts on two numbers: the share of installs that reach a first request (`chat_request_sent`), and retention. That needs each new install in exactly one cohort for good, the cohort on its PostHog person and events, a stable person (`2026-10-22-keep-the-analytics-distinct-id-in-settings-json.md`), and every first request counted, including one the deferred first send makes while the first model downloads.
- **Decision:**
  - **Drawing the cohort.** `lib/onboarding/experiment.ts` (experiment `onboarding_v1`) draws the cohort on the device before React mounts (`main.tsx`, after `rememberFirstLaunch`). Each variant has odds of one in three. The cohort is stored in localStorage (`atomic-onboarding-cohort`, `{experiment, variant, assignedAt}`). `getOnboardingVariant()` returns it, with a dev pin (`FORCE_ONBOARDING_VARIANT`) taking precedence.
    - Only a first launch (`isFirstLaunch()`) is drawn. Installs that used the app before stay out and keep `full`.
    - A dev build that pins a variant also stays out.
    - It is not a PostHog feature flag, because the first screen depends on it. A flag would have to arrive over the network before that screen, on a first launch that may be offline.
  - **Recording it in PostHog.**
    - The draw sends `onboarding_cohort_assigned`.
    - After the identity restore, `registerOnboardingCohort` puts `onboarding_experiment` and `onboarding_variant` on the person with `$set_once`, plus `onboarding_assigned_at`. It also registers them as super-properties, so every event carries them, including the startup events replayed from the queue.
  - **Factory reset.** A factory reset keeps the cohort, as it keeps the analytics id.
- **Consequences:**
  - In PostHog, filter persons or events on `onboarding_experiment = onboarding_v1` and break down by `onboarding_variant`. Use a funnel from `app_opened` with `is_first_launch = true` to `chat_request_sent`, and a retention insight on `app_opened`. Decide whether agent traffic through the local server (`api_server_request`) also counts as a first request; it carries the cohort too. Count the three weeks from the release that ships this. Dev builds have no PostHog key, so preview runs do not enter the data.
  - A person keeps its first cohort even if the device draws again, which can happen only if the stored cohort is lost while `settings.json` survives. The person's `$set_once` value is the one to analyse.
  - An install that opted out of analytics still gets a cohort and its variant, but reports nothing.
  - When the experiment ends, ship the winning variant as the default in `getOnboardingVariant()` and stop drawing. A later experiment uses a new name, so `onboarding_v1` cohorts are ignored.
- **Owner:** team.
- **Links:** `web-app/src/lib/onboarding/experiment.ts`, `web-app/src/lib/onboarding/steps.ts` (`getOnboardingVariant`), `web-app/src/main.tsx`, `web-app/src/providers/AnalyticProvider.tsx`, `web-app/src/constants/localStorage.ts` (`FACTORY_RESET_PRESERVE_KEYS`), `web-app/src/providers/DeferredFirstSendProvider.tsx`.

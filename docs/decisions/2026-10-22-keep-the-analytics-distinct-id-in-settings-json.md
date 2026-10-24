---
date: 2026-10-22
title: "Keep the analytics distinct id in settings.json, across a factory reset"
---

# 2026-10-22 — Keep the analytics distinct id in settings.json, across a factory reset

- **Context:** PostHog persons are keyed by `distinct_id`, and the planned onboarding experiment compares cohorts of persons over about three weeks, so an install has to stay one person. The web app meant to store PostHog's id in `settings.json` and `identify()` with it on later launches, but the Rust `AppConfiguration` had no `distinct_id` field: serde dropped it on every write, `getAppDistinctId()` always came back empty and `identify()` never ran. The only copy of the id was posthog-js's anonymous id in webview localStorage, which a factory reset clears (`DataProvider`) and any other storage wipe loses. Every such wipe made the install a new person, and a new Sentry user, since Sentry uses the same id.
- **Decision:**
  - `AppConfiguration` carries an optional `distinct_id` (`serde(default)`, not written when absent), so configurations written before it still load.
  - `restoreInstallDistinctId` (`web-app/src/lib/telemetry-identity.ts`) runs after `posthog.init` and before `opt_in_capturing`. With no stored id it stores posthog's own id. With a stored id that differs from posthog's (storage was wiped), it calls `posthog.identify(stored)`, so nothing is sent under the new throwaway id. When the two match it does nothing.
  - `update_app_configuration` keeps the stored id when the configuration it is given has none. Every writer sends back a whole configuration it read earlier, and on a first launch the startup autostart reconcile can read before the id is stored and then write after it.
  - A factory reset keeps the id: `factory_reset` carries it into the fresh configuration, as it already does with the autostart preference. A reset clears the app's data but does not make it a new install, and a reset user stays in their cohort.
- **Consequences:**
  - From the first launch of this build on, an install stays one PostHog person and one Sentry user through cleared webview storage and factory resets. Installs that upgrade store the id posthog already has, so existing persons keep their history.
  - A reset no longer gives an install a fresh analytics identity. The id is a random UUID with no personal data in it, and nothing is sent without analytics consent. Opting out in Settings → Privacy stops all sending but leaves the id in `settings.json`, so opting back in continues the same person.
  - A reinstall that keeps the app-data folder keeps the id. Deleting `settings.json` gives the install a new id.
  - Nothing can clear the id through `update_app_configuration` any more; clearing it would need its own command.
- **Owner:** team.
- **Links:** `src-tauri/src/core/app/{models,commands}.rs`, `src-tauri/src/core/system/commands.rs` (`factory_reset`), `web-app/src/lib/telemetry-identity.ts`, `web-app/src/providers/AnalyticProvider.tsx`; ADR `2026-06-09-add-zero-pii-sentry-crash-error-tracking-to-both-the-react.md` (the Sentry user is the PostHog id).

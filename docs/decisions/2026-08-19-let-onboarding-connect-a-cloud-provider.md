---
date: 2026-08-19
title: 'Let onboarding connect a cloud provider'
---

# 2026-08-19 — Let onboarding connect a cloud provider

- **Context:** the model step's only escape hatch was a small "Skip" link. A
  user with no machine for local inference, or who already pays for a cloud
  model, had no way to say so during onboarding: they skipped, landed in an
  empty chat, and had to discover Settings → Providers unaided. Configuring a
  key there already satisfies the onboarding gate
  (`hasValidProviders`), so the capability existed — it was just unreachable
  from the one screen where a new user is looking for it.

- **Decision:** the footer now leads with a secondary **"Add cloud provider"**
  button, with Skip demoted beneath it. It opens `AddCloudProviderDialog` — one
  dialog with two internal steps (a gallery of our cloud providers, then an API
  key field). Saving persists the key, marks setup complete, selects the
  provider's first model and enters the chat, mirroring `enterChatForDownload`.
  Notable choices:

  - **The 15 s auto-exit is disarmed while the dialog is open.**
    `MODEL_STEP_AUTO_EXIT_MS` would otherwise navigate away from under a user
    who went to fetch a key from their provider's dashboard. Two layers, both
    needed: the effect's dependency cancels a pending timer when the dialog
    opens, and a ref guard inside the callback covers a click at t≈14.99 s that
    fires before React commits the state update. Regression-tested in
    `describe('cloud provider' → 'auto-exit interaction')`.
  - **The gallery is built from the live provider list, not the registry
    store.** `updateProvider` silently no-ops on a name that is not already in
    that list, so a card sourced from anywhere else could save nothing with no
    error. It also keeps the registry store's import-time fetch out of
    SetupScreen's import graph.
  - **Filtering is by property, not by id.** Local engines
    (`isLocalProvider`) and loopback base URLs (`isLoopbackUrl` — this is what
    excludes `ollama`) are dropped, so a future LM-Studio-style entry is handled
    without a code change. `azure` is excluded by name: its `base_url` is the
    literal placeholder `https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1`,
    so a key-only save yields a provider that looks connected and fails on first
    request. The trigger is hidden entirely when nothing survives the filter.
  - **The cloud exit does not arm the model reminder.** That nudge is for users
    who left empty-handed; a configured key is a finished setup.
  - **Writing a key is single-sourced.** `web-app/src/lib/provider-api-key.ts`
    owns what an API-key write means — the `api-key` settings entry *and* the
    top-level `api_key` mirror — and the settings route now builds its patch
    from it. Writing one without the other yields a provider that looks
    configured but cannot send a request. `updateSettings` is called for parity
    with local providers but is deliberately never awaited or treated as the
    success condition: it resolves an engine extension, and cloud providers have
    none, so it is a no-op for them.

  We did not reproduce the reference design's "Models available" / "Key
  connection only" subtitle split: all our cloud providers ship a curated model
  list and `supports_model_listing` is absent throughout the registry, so that
  label would read identically on every card. Cards show the model count
  instead, matching Settings → Providers.

- **Consequences:** a BYOK user finishes onboarding with a working model instead
  of an empty chat, and the exit is visible in telemetry as
  `onboarding_completed.exit_path = 'cloud_provider'` plus the existing
  `provider_key_configured`. Costs: onboarding now depends on the provider
  registry having resolved (hence the hidden-trigger fallback), and any future
  provider that needs more than a key to work must be added to
  `KEY_ONLY_UNSUPPORTED` alongside `azure`. **Watch for:** keys are persisted in
  plaintext `localStorage` under `model-provider` — unchanged by this record,
  but this UI is now a second, more prominent entry point to that storage.

- **Owner:** `team`

- **Links:** `web-app/src/containers/dialogs/AddCloudProviderDialog.tsx`,
  `web-app/src/lib/provider-api-key.ts`,
  `web-app/src/containers/SetupScreen.tsx`,
  `web-app/src/containers/__tests__/SetupScreen.test.tsx`

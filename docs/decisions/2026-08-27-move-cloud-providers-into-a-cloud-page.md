---
date: 2026-08-27
title: 'Move cloud providers out of Settings into a Cloud page'
---

# 2026-08-27 — Move cloud providers out of Settings into a Cloud page

- **Context:** Settings listed local engines and all thirteen `atomic-chat-conf`
  cloud providers in one flat list — the `MODEL PROVIDERS` section of
  `web-app/src/containers/SettingsMenu.tsx` and the (unlinked)
  `/settings/providers` overview. Configuring a cloud provider is "connect an
  account", not "tune an inference engine", yet it lived three levels deep on
  `/settings/providers/$providerName` — a 3032-line page whose other rows are
  `dflash`, `mtp`, `cache_type_k/v` and the rest of the llama.cpp expert surface.
  A previous Local/Cloud split ([2026-08-12](2026-08-12-split-model-providers-into-local-and-cloud-tabs-and-hide-engine-settings.md))
  was reverted in full on [2026-08-13](2026-08-13-revert-the-settings-and-model-providers-ui-rework-keep-runtime.md)
  because it reached into all thirteen settings pages *and* the provider store's
  persisted shape (`version: 15` plus a migration).

- **Decision:** connecting a cloud provider moves to its own top-level page,
  `/cloud`, reached from a **Cloud** row in the primary left sidebar. Settings
  keeps local engines only. Three choices make this a much smaller change than
  the reverted one:

  - **`active` keeps its meaning** ("enabled / show in the picker"), for local
    and cloud alike. "Connected" is *derived*, never stored:
    `Boolean(api_key?.trim()) || isKeylessRemoteProvider(p)`, the same condition
    `syncRemoteProviders`, `ensureRemoteProviderReady` and
    `DropdownModelProvider` already evaluate. **No persist migration; `version`
    stays `14`; `ProviderObject` gains and loses no field.**
  - **The Settings/Cloud split is two exact complements** —
    `isLocalEngineProvider = isLocalProvider(name) || persist === true`, and
    `isCloudProvider` is its negation. Nothing can fall between the two lists.
    This is what keeps `ollama` reachable: it is a remote-transport provider on
    a loopback URL, so a name-only local filter would strand it in no UI at all.
    It is listed under a **Self-hosted** group, together with user-created
    OpenAI-compatible providers.
  - **The models list stays add/remove, not the reference's checkbox
    multi-select.** `provider.models` already *is* the selected set; a separate
    selection field would mean a persisted-shape change, i.e. exactly the
    combination that got the last attempt reverted.

  `/settings/providers/$providerName` stays alive and redirects to
  `/cloud?provider=…` for cloud providers via `beforeLoad`, so bookmarks, the
  model picker's gear and `DeleteProvider` keep working.

- **Consequences:** Settings becomes a short list of engines; connecting an
  account is one click from the sidebar and deep-linkable
  (`/cloud?provider=openai`). Costs and things to watch:

  - Two test suites need reworking: `SettingsMenu.test.tsx` (its fixtures are
    cloud providers) and `routes/settings/providers/__tests__/index.test.tsx`
    (six tests drive `AddProviderDialog`, which moves to `/cloud`).
  - `handleRefreshModels` is extracted from `$providerName.tsx` into
    `web-app/src/lib/refresh-provider-models.ts` because it now has two callers.
    Behaviour is unchanged, including the three toast branches and the
    `supports_model_listing !== false` gate.
  - Onboarding is untouched: `SetupScreen`, `AddCloudProviderDialog` and
    `selectCloudGalleryProviders` stay exactly as they are. That selector is
    deliberately *not* reused here — it drops `ollama` and `azure` for reasons
    that only apply to a key-only dialog.
  - **Revert recipe:** delete `web-app/src/routes/cloud/`,
    `web-app/src/containers/cloud/`, `web-app/src/lib/cloud-providers.ts`,
    `web-app/src/lib/refresh-provider-models.ts`,
    `web-app/src/components/animated-icon/cloud.tsx` and the fourteen
    `locales/*/cloud.json`; revert the filters in `SettingsMenu.tsx` and
    `routes/settings/providers/index.tsx`, the `beforeLoad` in
    `$providerName.tsx`, the gear target in `DropdownModelProvider.tsx` and the
    `redirectTo` prop on `DeleteProvider.tsx`; regenerate `routeTree.gen.ts`.
    Nothing to down-migrate, because nothing was migrated.
  - `deleteModel` remains global and permanent (it appends to `deletedModels`,
    which `setProviders` honours for every provider forever). No bulk
    "clear"/"select none" affordance may ever be wired to it.

- **Owner:** `team`

- **Links:** `web-app/src/routes/cloud/index.tsx`,
  `web-app/src/lib/cloud-providers.ts`,
  `web-app/src/containers/SettingsMenu.tsx`,
  `web-app/src/routes/settings/providers/$providerName.tsx`,
  `web-app/src/components/left-sidebar/NavMain.tsx`,
  [Revert the Settings and Model Providers UI rework](2026-08-13-revert-the-settings-and-model-providers-ui-rework-keep-runtime.md),
  [Let onboarding connect a cloud provider](2026-08-19-let-onboarding-connect-a-cloud-provider.md)

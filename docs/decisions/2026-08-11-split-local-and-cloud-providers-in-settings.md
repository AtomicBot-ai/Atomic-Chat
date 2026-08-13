---
date: 2026-08-11
title: "Split local and cloud providers in Settings; `active` means the cloud provider was added"
---

# 2026-08-11 — Split local and cloud providers in Settings; `active` means the cloud provider was added

- **Context:** every entry in `atomic-chat-conf/providers/registry.json` ships
  with `active: true`, and `setProviders` in
  `web-app/src/hooks/useModelProvider.ts` defaulted unknown providers to
  `active: true` as well. Settings → Model Providers therefore listed all
  thirteen cloud providers interleaved with the local engines, none of which the
  user had configured. There was no way to tell "I use this" from "this exists".
- **Decision:** treat `active` on a cloud provider as "the user added it".
  Local engines (`LOCAL_PROVIDER_NAMES`) are always listed and keep `active` as
  a plain enable/disable switch; cloud providers only appear in the new Cloud
  section once connected. Everything else lives behind an "Add provider"
  catalog dialog (`AddCloudProviderDialog`) that hands off to a key-entry dialog
  (`ConnectProviderDialog`) and offers a Custom entry for any other
  OpenAI-compatible endpoint. New registry entries now arrive inactive, and a
  `version: 15` persist migration retires clouds that were never set up.
- **Consequences:** the sidebar and the providers page stay short and reflect
  the user's own setup, and the model picker inherits the same shortlist since
  it already filters on `active`. Cost: the migration is name-based
  (`isLocalProvider` / `isLoopbackUrl`) rather than registry-based, because the
  registry store may not have resolved when zustand rehydrates — a keyless
  provider pointed at a non-loopback URL is treated as "never set up" and has to
  be re-added once. Keys are preserved on disconnect, so re-adding is one click,
  and the catalog flags those entries as "Key saved". Anything that assumed a
  registry provider is visible by default has to go through the catalog now.
- **Owner:** `team`.
- **Links:** `web-app/src/hooks/useModelProvider.ts`,
  `web-app/src/utils/registerRemoteProvider.ts`,
  `web-app/src/containers/SettingsMenu.tsx`,
  `web-app/src/routes/settings/providers/index.tsx`,
  `web-app/src/containers/dialogs/AddCloudProviderDialog.tsx`,
  `web-app/src/containers/dialogs/ConnectProviderDialog.tsx`.

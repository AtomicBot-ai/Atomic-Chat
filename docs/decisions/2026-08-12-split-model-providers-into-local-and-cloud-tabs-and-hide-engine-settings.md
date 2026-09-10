---
date: 2026-08-12
title: "Split Model Providers into Local/Cloud tabs and hide engine settings"
---

# 2026-08-12 — Split Model Providers into Local/Cloud tabs and hide engine settings

- **Context:** Settings → Model Providers listed every provider twice: once as a
  sidebar section with a row per engine and per connected cloud, and again as two
  stacked cards on `/settings/providers`. Each local engine's detail page then
  opened onto the full `settings.json` surface — `dflash`, `mtp`, `eagle3`,
  `cache_type_k/v`, `kv_bits`, `concurrent_*`, `extra_args` and the rest — next to
  the backend version dropdown, the install-from-file button and three separate
  update actions, one page per engine. Choosing a runtime meant navigating a tree
  and reading a wall of expert flags.
- **Decision:** `/settings/providers` becomes one page with Local and Cloud tabs,
  matching the MCP Servers pattern. Local is a runtimes list (TurboQuant, upstream,
  MLX on macOS, Foundation Models) with a version dropdown, an activity switch and
  a "Models" link per engine, plus two header actions: one "Check for engine
  updates" covering both llama.cpp providers, and "Manage installed packs" for
  listing, revealing, deleting and hand-installing engine builds. Cloud keeps the
  existing connect/manage flow. Engine settings are removed from the UI — the
  settings card is not rendered for local providers, leaving only the model list.
  The sidebar collapses to a single "Model Providers" entry.
- **Consequences:** Engine tuning is no longer reachable from the UI; every key
  stays in `settings.json` and keeps applying at its default, so nothing changes
  at runtime and re-exposing a key later is a rendering decision, not a migration.
  `/settings/providers/$providerName` stays alive for local engines because import
  from disk, per-model settings and deletion exist nowhere else — the Hub only
  lists what is already downloaded. Removing a backend build is refused for the
  build in use, since deleting it would leave `version_backend` pointing at a
  missing directory. Every provider detail page carries a "Back" button that
  returns to `/settings/providers?tab=local|cloud`; the tab lives in the URL
  because the list defaults to Local and would otherwise drop a user coming back
  from a cloud provider on the wrong tab.
- **Owner:** team
- **Links:** `web-app/src/routes/settings/providers/index.tsx`,
  `web-app/src/containers/providers/LocalRuntimePanel.tsx`,
  `web-app/src/containers/dialogs/ManageEnginePacksDialog.tsx`,
  `web-app/src/containers/SettingsMenu.tsx`,
  `web-app/src/routes/settings/providers/$providerName.tsx`,
  `web-app/src/hooks/useBackendUpdater.ts`

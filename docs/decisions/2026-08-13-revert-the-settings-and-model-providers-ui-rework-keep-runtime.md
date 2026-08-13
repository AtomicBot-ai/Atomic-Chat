---
date: 2026-08-13
title: 'Revert the Settings and Model Providers UI rework; keep runtime engine updates'
---

# 2026-08-13 — Revert the Settings and Model Providers UI rework; keep runtime engine updates

- **Context:** Four commits on top of `v2.0.9` reworked Settings end to end: a
  base/advanced mode switch that folded `/settings/interface` into
  `/settings/general`, a `/settings` layout route owning the shared chrome, a
  Local/Cloud split of Model Providers with a runtimes list and no engine
  settings, and connect/manage dialogs for cloud providers. The same range also
  carried the work that lets a local engine be replaced at runtime: an
  `atomic-chat-conf`-driven catalog for `llamacpp-upstream` on macOS,
  `verify_backend_binary`, `mergeBackendOptions`, release-tag ordering and the
  `BaseExtension.registerSettings` recommendation fix. The UI half turned out to
  reach further into the product than we are ready to absorb — it touches all 13
  settings pages, the sidebar, the provider detail page and the provider store's
  persisted shape — while the engine half is what we actually wanted.
- **Decision:** Revert every UI change to its `v2.0.9` form and keep everything
  outside `web-app/src`. The cut is exactly that directory boundary: `Makefile`,
  `core/`, `extensions/` and `src-tauri/plugins/tauri-plugin-llamacpp-upstream/`
  are untouched, so an engine still updates through a manifest edit with no app
  release. Settings goes back to per-page chrome, `/settings/interface` as its
  own page, a sidebar row per engine and the full engine-settings surface on
  `/settings/providers/$providerName`. The hub, reasoning-display and onboarding
  work that shares those commits stays.
- **Consequences:**
  - The restored provider page gates its engine-update button on
    `provider?.provider !== 'llamacpp'`, so there is no UI trigger for an
    upstream update. Reaching one is deliberately left for a follow-up that
    updates automatically rather than on a button. Nothing is lost on the
    extension side: `checkForEngineUpdate`, `listInstalledBackends` and
    `deleteBackend` are all still there, unwired.
  - Manual hot-swap of upstream keeps working through the `version_backend`
    dropdown, which now offers the merged list from
    [the engine-version-dropdown ADR](2026-08-12-list-every-runnable-build-in-the-engine-version-dropdown.md).
    That record survives, narrowed to its extension half — `mergeBackendOptions`
    and the `settingsChanged` emit after `configureBackends()`; its UI half,
    `LocalRuntimePanel` and the mount-time provider re-read, is gone.
  - `useModelProvider`'s persisted version drops 15 → 14, retiring the migration
    that deactivated cloud providers carrying neither an API key nor a loopback
    URL. `v2.0.10` was never tagged and never reached `main`, so no user is on
    version 15; a developer who ran this branch keeps those providers switched
    off and turns them back on from the list.
  - Re-landing any of this is a UI decision, not a backend one. The engine
    contract the reverted screens were built against is unchanged.
- **Owner:** team
- **Links:** `web-app/src/routes/settings/`,
  `web-app/src/containers/SettingsMenu.tsx`,
  `web-app/src/hooks/useBackendUpdater.ts`,
  `web-app/src/hooks/useModelProvider.ts`,
  [Update upstream llama.cpp at runtime on macOS too](2026-08-12-update-upstream-llama-cpp-at-runtime-on-macos-too.md)
  (kept in full)

<!--
Supersedes: 2026-08-11-own-the-settings-chrome-in-a-layout-route.md
Supersedes: 2026-08-11-split-local-and-cloud-providers-in-settings.md
Supersedes: 2026-08-12-split-model-providers-into-local-and-cloud-tabs-and-hide-engine-settings.md
Supersedes: 2026-08-12-list-every-runnable-build-in-the-engine-version-dropdown.md
            (only the UI clause; the extension-side merge stays)
-->

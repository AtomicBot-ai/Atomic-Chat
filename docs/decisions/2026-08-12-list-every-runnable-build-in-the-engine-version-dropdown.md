---
date: 2026-08-12
title: 'List every runnable build in the engine version dropdown'
---

# 2026-08-12 — List every runnable build in the engine version dropdown

- **Context:** The Local tab's version dropdown and its "Manage installed packs"
  dialog disagreed about which builds exist. The dialog reads the disk, so it is
  always complete. The dropdown was assembled differently per provider and each
  way lost entries. `llamacpp-upstream` built its list from static
  `latest/<variant>` sentinels plus the installed builds; the sentinel set is
  empty on macOS, so the list there could only ever contain what was already
  installed and no manifest release was reachable. `llamacpp` built its list
  from the hardware-gated catalog and pinned in only the _currently selected_
  install, so a side-loaded or de-listed build disappeared the moment the user
  switched away from it. Both providers also wrote a `recommended` value without
  checking it was among the options: on a live install the dropdown recommended
  `turboquant-macos-arm64-d785414` and `b9222/macos-arm64` while offering
  neither.
- **Decision:** The dropdown is the union of everything runnable, assembled from
  ordered tiers by a shared `mergeBackendOptions(tiers, recommended)` helper in
  each provider's `backend.ts`: manual `latest/*` sentinels first (where the
  platform has them), then the catalog for this host, then whatever else is on
  disk. The first spelling of a `version/backend` wins, so a build present in
  several tiers keeps its richest label, and the recommendation is forced into
  the list when no tier carried it.

  Building the list is not enough for the UI to show it. The app reads its
  provider snapshot once at startup, while `configureBackends()` is still
  resolving the release index behind an unawaited promise, so the snapshot
  captures the early registration — the bundled build alone. Two additions make
  the list reach the screen: `configureBackends()` emits `settingsChanged` for
  `version_backend` right after the full registration, and the Local tab
  re-reads the providers when it mounts. Neither alone is sufficient — the event
  is lost if the catalog resolves from cache before the global handler
  subscribes, and a mount-time read is stale for a tab already open when a slow
  catalog lands.
- **Consequences:** A user on macOS can pick a newer upstream release straight
  from the list instead of waiting on the update button — though only from
  2026-08-12, when
  [runtime updates reached macOS](2026-08-12-update-upstream-llama-cpp-at-runtime-on-macos-too.md);
  before that both the sentinel tier and the catalog tier were empty there, so
  the merged list still held nothing but the installed builds. A build that left
  the release index stays selectable for as long as it is installed. The list is
  longer and mixes "installed" with "downloadable" — the labels carry that
  distinction, the ordering does not. The two `mergeBackendOptions` copies are
  duplicated per extension, matching how the rest of `backend.ts` is already
  split between the two provider trees.
- **Owner:** team
- **Links:** `web-app/src/containers/providers/LocalRuntimePanel.tsx`,
  `extensions/llamacpp-extension/src/backend.ts`,
  `extensions/llamacpp-upstream-extension/src/backend.ts`,
  `extensions/llamacpp-extension/src/index.ts`,
  `extensions/llamacpp-upstream-extension/src/index.ts`,
  `docs/decisions/2026-08-12-split-model-providers-into-local-and-cloud-tabs-and-hide-engine-settings.md`

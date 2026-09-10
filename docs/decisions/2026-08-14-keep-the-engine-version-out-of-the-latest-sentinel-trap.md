---
date: 2026-08-14
title: 'Keep the engine version out of the latest/ sentinel trap'
---

# 2026-08-14 — Keep the engine version out of the `latest/` sentinel trap

- **Context:** A tester on macOS saw no engine-update banner at startup and had to
  press "Check engine updates" by hand; the download then finished long before
  the settings page admitted it. Both symptoms come from the same place.
  `registerSettings()` in `core/src/browser/extension.ts` resets a stored
  dropdown value to `options[0]` when the incoming options no longer contain it.
  For `version_backend` that fallback is not a neutral default: `options[0]` is
  the `latest/<variant>` sentinel, and `reconcileBackendReleaseTag()` treats a
  non-concrete value as "nothing configured yet" and returns. The upstream
  manifest advertises only the newest tag, so an older selected tag stayed in the
  list purely through its copy on disk — exactly what `removeOldBackendVersions`
  prunes after an update. One launch in that window switched off automatic engine
  updates for the rest of the installation's life, while the UI read "Latest
  macos-arm64" and looked healthy. TurboQuant has no sentinel, so there the same
  fallback silently downgraded to an arbitrary older release instead.
- **Decision:** Both extensions pin the saved `version_backend` into the options
  they register whenever it is a concrete `<tag>/<variant>`, not only when that
  build is still installed. The options list is the extension's contract with
  core's fallback, so the value it must protect cannot depend on disk state.
  `reconcileBackendReleaseTag()` additionally treats a parked `latest/<variant>`
  as recoverable: it resolves the sentinel through `downloadRecommendedBackend()`
  (a no-op transfer when that release is already on disk) instead of returning,
  which heals installations that are already stuck.

  The manual path stops waiting on work the user is not waiting for. After the
  hot-swap the settings route re-reads the provider and confirms immediately, and
  rebuilds the backend catalog — a full `configureBackends()`, meaning a manifest
  refetch plus a device probe, some ten seconds — off the critical path. The
  banner and the completion toast name the release tag as well as the variant;
  `macos-arm64` alone does not say which build is landing.
- **Consequences:**
  - The dropdown can offer a release that is neither in the manifest nor on disk.
    Selecting it downloads it, which is what the `latest/` entries do anyway, and
    is strictly better than losing the value.
  - A sentinel left over from an older build now triggers an unattended download
    on the next launch. That is the same bandwidth the tag reconciler was always
    allowed to spend, and it happens once: the resolved tag is persisted.
  - Automatic engine updates are no longer silently absent, so the banner is the
    only signal that a launch is spending bandwidth. It has to keep naming the
    provider and the target release.
- **Owner:** team
- **Links:** `extensions/llamacpp-upstream-extension/src/index.ts`,
  `extensions/llamacpp-extension/src/index.ts`,
  `core/src/browser/extension.ts`,
  `web-app/src/routes/settings/providers/$providerName.tsx`,
  `web-app/src/containers/dialogs/BackendUpdater.tsx`,
  `docs/decisions/2026-08-13-apply-the-detected-backend-tier-at-startup-for-upstream.md`,
  `docs/decisions/2026-08-12-follow-the-atomic-chat-conf-manifest-tag-for-upstream-llama-cpp.md`

---
date: 2026-08-13
title: 'Apply the detected backend tier at startup for llamacpp-upstream'
---

# 2026-08-13 — Apply the detected backend tier at startup for llamacpp-upstream

- **Context:** Every primitive for "run the best build this machine can" already
  existed. `refreshOptimalBackendCache()` returns a concrete
  `recommendedBackend`, and `downloadRecommendedBackend()` ->
  `applyBackendLive()` downloads and hot-swaps without a restart. The result was
  used for one thing only: a hint in the chat after a model load. A user who
  skipped backend onboarding kept running CPU or Vulkan on a CUDA machine until
  he happened to notice a prompt. Meanwhile the app was *already* downloading
  hundreds of megabytes unasked — `reconcileBackendReleaseTag()` on app update —
  and the progress banner in `BackendUpdater` covered only TurboQuant, while a
  separate "Update now / Remind me later" toast asked about the very archive
  reconcile might be fetching.
- **Decision:** `applyStartupBackendUpgrade()` applies the detected tier for
  `llamacpp-upstream` only, called from `StartupBackendCoordinator` once per
  process inside the existing `isPlatformTauri() && (IS_WINDOWS || IS_LINUX)` +
  `hardwareReady` + `isOnboardingPending` gates. `planStartupBackendUpgrade()`
  holds the conditions: GPU detection only, a change of backend *id* only (a
  newer tag for the same id is the tag reconciler's job, and two paths must not
  chase one archive), never ROCm (~980 MB unpacked belongs behind the explicit
  recommendation dialog), and a localStorage attempt record so a failed download
  is not retried on every launch. TurboQuant keeps its manual "Find optimal
  backend": auto-applying for both providers would mean two uncontrolled
  multi-hundred-megabyte downloads in one launch.

  Because a second unattended download now exists, the progress banner covers
  whichever provider is downloading rather than TurboQuant alone, and the
  version-update toast is gone — with both tag reconcile and tier upgrade
  automatic, asking permission for one of them was misleading.

  "Check engine updates" is also no longer hidden for `llamacpp-upstream`: the
  extension side (`checkForEngineUpdate()`) has been there since 2026-08-12, only
  the two provider gates in the settings route were left.
- **Consequences:**
  - A Windows or Linux user on the upstream default ends up on his best GPU tier
    without being asked, and sees a banner while it happens. Upstream publishes
    one CPU archive per platform, so there is no AVX tier to pick — the only
    CPU-side logic remains the `isUnsupportedNoAvxCpu()` guard, and the real
    choice is CUDA 13 / CUDA 12 / ROCm / Vulkan.
  - This overrides "Detection never opens startup UI" from the 2026-07-30 ADR for
    this provider. The spirit survives: nothing blocks or prompts at startup, the
    only surface is a non-modal banner.
  - The cost is bandwidth on someone else's connection. The attempt guard, the
    id-change requirement and the ROCm exclusion are what keep it bounded; loosen
    any of them and a failed download can repeat every launch or a ~1 GB archive
    can land silently.
  - Losing the toast means a user can no longer decline an engine update. That is
    consistent with what already happened for the release tag, and the settings
    dropdown still allows pinning a specific build by hand.
- **Owner:** team
- **Links:** `web-app/src/lib/startupBackendRecommendations.ts`,
  `web-app/src/providers/StartupBackendCoordinator.tsx`,
  `web-app/src/containers/dialogs/BackendUpdater.tsx`,
  `web-app/src/routes/settings/providers/$providerName.tsx`,
  `extensions/llamacpp-upstream-extension/src/index.ts`,
  `docs/decisions/2026-07-30-cache-optimal-backends-for-chat-upgrade-prompts.md`,
  `docs/decisions/2026-08-12-follow-the-atomic-chat-conf-manifest-tag-for-upstream-llama-cpp.md`

<!--
Supersedes: 2026-07-30-cache-optimal-backends-for-chat-upgrade-prompts.md
(only the "Detection never opens startup UI" clause, and only for llamacpp-upstream)
-->

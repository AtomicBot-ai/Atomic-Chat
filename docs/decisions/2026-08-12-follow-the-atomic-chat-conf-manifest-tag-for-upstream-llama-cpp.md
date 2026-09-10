---
date: 2026-08-12
title: "Follow the atomic-chat-conf manifest tag for upstream llama.cpp"
---

# 2026-08-12 — Follow the atomic-chat-conf manifest tag for upstream llama.cpp

- **Context:** `llamacpp-upstream` carried a compiled-in tag
  (`LLAMACPP_UPSTREAM_PINNED_TAG = 'b10205'`) in two places. `fetchRemoteBackends`
  discarded any live manifest whose `tag_name` differed from it, and
  `enforcePinnedBackendVersion` re-pinned `version_backend` to that tag on every
  launch. Together they meant the `atomic-chat-conf` manifest could move to
  `b10344` and no user would ever see it, and a user who installed a newer build
  by hand was silently downgraded on the next start. The Local tab's
  "Check for engine updates" button would have had nothing to offer for this
  provider.
- **Decision:** The manifest tag is authoritative. `fetchRemoteBackends` follows
  whatever `atomic-chat-conf` publishes; the compiled-in tag survives only as the
  bundled offline baseline used when every network transport fails. Startup
  reconciliation (`reconcileBackendReleaseTag`, ex `enforcePinnedBackendVersion`)
  now targets the newest catalog release instead of the compiled-in tag, and
  refuses to cross backend families. A new `checkForEngineUpdate()` mirrors the
  TurboQuant method, forcing a manifest refetch so a release published while the
  app was open is visible without a restart.
- **Consequences:** Upstream engine updates reach users without an app release,
  which is what the manifest was built for — and what the unified update button
  promises. The cost is that a bad manifest bump now reaches users directly, so
  `atomic-chat-conf` must only move once a build is verified; the app-side
  verification gate is gone. Downgrades no longer happen behind the user's back.
  macOS is unaffected: `fetchRemoteBackends` still returns `[]` there because
  upstream builds ship bundled.
- **Owner:** team
- **Links:** `extensions/llamacpp-upstream-extension/src/backend.ts`,
  `extensions/llamacpp-upstream-extension/src/index.ts`,
  `extensions/llamacpp-upstream-extension/src/test/backend.test.ts`,
  `extensions/llamacpp-upstream-extension/src/test/index.test.ts`,
  `docs/decisions/2026-07-28-pin-backend-artifacts-to-verified-tags.md`

---
date: 2026-09-16
title: "Bound the model load's wait on backend configuration, then load from disk"
---

# 2026-09-16 — Bound the model load's wait on backend configuration, then load from disk

- **Context:** `llamacpp-upstream`'s `load()` waited on `configureBackendsPromise`
  without a bound in two places: when `version_backend` is not a concrete
  `<tag>/<backend>` (ATO-124, the `latest/<backend>` sentinel) and when it is
  concrete but no exe for it is on disk (ATO-233). The promise covers the whole
  configuration pass — bundled-build extraction, disk recovery, the catalog fetch
  and `reconcileBackendReleaseTag` — and the network legs run through the Tauri
  HTTP layer, where a stalled TCP/TLS connection can outlive every JS abort and
  leave the promise pending forever (the reason `checkForEngineUpdate` already
  wraps the same promise in `withTimeout(…, 20_000)`). When that happened every
  model load hung with the spinner up, and a project file ingest hung with it,
  because `embed()` loads the embedding model through the same path.

  Two options were on the table once the wait is bounded: (a) go ahead with what
  is on disk, or (b) fail fast with a "backend configuration is taking too long;
  check your connection" error.

- **Decision:** (a). Both waits go through `waitForBackendConfiguration`, which
  is `withTimeout` over the promise with `BACKEND_CONFIG_LOAD_WAIT_MS = 20_000`
  (the bound the sibling paths already use, and 2.5× the manifest fetch timeout).
  On expiry it logs a warning and the load proceeds. No new error code and no
  new locale string.

  Why proceeding is safe against the two races the waits were added for:
  - ATO-124 (unresolved sentinel → 404 retry loop): `performLoad` already
    resolves a leftover `latest/<backend>` itself (release lookup, then newest
    installed copy of the family), and `downloadAndInstallBackend` refuses a
    `latest` tag with `BACKEND_TAG_UNRESOLVED` instead of building a 404 URL.
    The loop cannot come back.
  - ATO-233 (stale concrete tag → hang until the fallback finishes):
    `ensureBackendReady(allowFallback = true)` checks for an installed build of
    the same variant *before* any download and otherwise runs the ATO-178/179
    tiered fallback. That path is slower than the configuration pass swapping
    the tag in, but it is finite — the old wait was an optimisation for the
    common case, not a correctness guard, and past the bound a finite slow path
    beats an infinite one.
  - The pass's local phase (bundled build, disk recovery, early settings)
    completes in moments, so in practice the bound only ever expires in the
    catalog phase, after `version_backend` has already been made concrete.

  Why not (b): the load has everything it needs on disk in every case the two
  waits cover; what is missing is the remote catalog, which the load path can
  do without. Failing would turn a working local backend into a failed load and
  a failed project ingest. The clear error still exists where it belongs: when
  nothing on disk can serve the load, `ensureBackendReady` throws its existing
  "could not be downloaded … check your internet connection (Settings → Proxy)"
  message, and an unresolvable sentinel lands on the same message through
  `BACKEND_TAG_UNRESOLVED`.

- **Consequences:**
  - A stalled catalog fetch costs a load at most 20 s of waiting instead of
    forever; the warning names the bound and the backend used.
  - The configuration pass can now finish *after* a load went ahead and swap
    `version_backend` (same-family auto-upgrade, sentinel recovery). The
    in-flight load keeps its own `cfg` copy, and `getEffectiveBackend()` /
    `reportBackendMismatch` already reconcile "configured" with "actually
    launched", so the UI shows the truth either way.
  - Residual, rare: a parked sentinel with no bundled build makes
    `reconcileBackendReleaseTag` download the release; a load that times out
    meanwhile resolves the same tag and may start a second download of it.
    The download manager supersedes by task id, so this ends in a usable
    install, not a corrupt one — but it is a duplicate transfer. Only reachable
    on a build without the bundled backend.
  - Not changed, by scope: `getDevices()` has the same unbounded wait, and
    `extensions/llamacpp-extension` (the fork) carries the same two waits.
    `ensureBackendReady`'s own download leg is unbounded as before.
- **Owner:** @danyurkin
- **Links:** `extensions/llamacpp-upstream-extension/src/index.ts`
  (`waitForBackendConfiguration`, `startLoad`, `withTimeout`,
  `ensureBackendReady`, `resolveBackendFallback`), tests in
  `extensions/llamacpp-upstream-extension/src/test/index.test.ts`
  ("load waits for backend configuration"). Related: ATO-124, ATO-233,
  ATO-178/179, 2026-09-15 "Say what a model load is waiting on".

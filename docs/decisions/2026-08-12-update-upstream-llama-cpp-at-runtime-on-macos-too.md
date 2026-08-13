---
date: 2026-08-12
title: 'Update upstream llama.cpp at runtime on macOS too'
---

# 2026-08-12 — Update upstream llama.cpp at runtime on macOS too

- **Context:** Both local engines were supposed to pick up a new build at app
  start and from "Check for engine updates". TurboQuant did so on all three
  platforms; `llamacpp-upstream` did so only on Windows and Linux. On macOS
  `fetchRemoteBackends` returned `[]` before any network call, so
  `checkForEngineUpdate` compared the bundled build with itself and honestly
  reported "up to date" while the machine sat on `b10205` and the manifest had
  moved to `b10344`. Three things kept it there: the early return, a
  `parseManifestForPlatform` that knew only `windows` and `linux`, and an
  `atomic-chat-conf` manifest with no macOS assets at all. The bundle-only
  behaviour was deliberate — recorded in
  [the 2026-05-19 macOS provider ADR](2026-05-19-ship-upstream-ggml-org-llama-cpp-as-a-second-macos-provider-no.md),
  which asked that re-enabling runtime fetching be a deliberate ADR change.
  This is that change.
- **Decision:** macOS reads the same catalog as everyone else. The manifest
  lists `llama-<tag>-bin-macos-arm64.tar.gz` and nothing for Intel: runtime
  engine updates on macOS are Apple Silicon only, which is where the product
  is, and an Intel Mac keeps running the build its installer shipped.
  `parseManifestForPlatform` gained a `macos` branch that keeps only the host
  arch — macOS lists backends unfiltered, so without the filter an Intel host
  would be handed the arm64 build the moment the manifest lists one — and the
  early return is gone. For the same reason the dropdown's `latest/*` sentinel
  is offered only for `macos-arm64`. The Makefile's
  Darwin branch now resolves the bundled tag from the manifest like the
  Windows and Linux branches, so bundle and catalog can no longer drift; the
  `LLAMACPP_UPSTREAM_TAG ?= b10205` default pin is retired and the variable
  survives only as an override.

  Two ordering bugs surfaced once macOS had something to compare against, and
  both were platform-wide rather than macOS-specific. Backend sorting ranked
  `order` first, which is install mtime for a build on disk and `0` for one
  that only exists in the manifest — the installed build always won, so no
  non-Windows host would ever be offered an update. Sorting now ranks the
  `bNNNN` release tag numerically first on every platform, falling back to the
  old comparison for tags that are not release tags. Separately, the launch
  force-switch to the bundled build now requires the bundled build to actually
  be newer, so a downloaded `b10344` survives a cold start instead of being
  demoted to the bundled tag.

  A downloaded macOS build must prove itself before it is offered: after
  extraction, `llama-server --version` must report the tag we asked for. This
  reuses the Rust `backend_binary_matches_version`, now exposed as the
  `verify_backend_binary` command, which also applies the `0o755` loop that
  previously ran only on the bundled install path. A build that fails the gate
  is deleted and the download reports a real error; `version_backend` is never
  touched.
- **Consequences:**
  - A macOS user gets new upstream engines the same way Windows and Linux users
    do — a JSON edit in `atomic-chat-conf`, no app release. The cost is the same
    too: a bad manifest bump reaches users directly, so the tag only moves once
    a build is verified.
  - **Runtime downloads are not signed, and must not be.** Measured against
    `llama-b10375-bin-macos-arm64.tar.gz` on Apple Silicon: `codesign -dvvv`
    reports `flags=0x20002(adhoc,linker-signed)`, `codesign --verify` says the
    binary is valid and satisfies its designated requirement, `xattr -l` is
    empty, and `--version` runs. Re-checked on `b10344` from the layout the app
    actually produces — `normalize_backend_layout` flattens the tarball's
    `llama-<tag>/` into `build/bin/` — where `otool -L` shows only `@rpath`
    entries that resolve against the dylibs sitting beside the binary, `tar`
    leaves everything `0755`, and both `--version` (`version: 10344`) and
    `--list-devices` work. Quarantine is set by browsers, not by our
    reqwest download or by `tar::Archive::unpack`, and the target
    (`<data>/llamacpp-upstream/backends/<tag>/<backend>/`) is outside the
    `.app`, so neither Gatekeeper nor the bundle seal is involved. Our hardened
    runtime does not reach `llama-server` either — it is a separate process,
    never a loaded library.
  - **The bundled path still needs Developer ID, for the opposite reason.** A
    bundled build is a nested Mach-O of the `.app`, so notarization demands our
    Team ID, hardened runtime and a secure timestamp; an ad-hoc binary fails
    both the submission and the seal. The re-signing loop in
    `download-llamacpp-upstream-backend` stays. Deleting it as "redundant with
    the download path", or adding signing to the download path as
    "consistent", each breaks one of the two.
  - **Mirroring re-signed upstream releases was rejected.** It buys nothing at
    exec time given the above and costs a per-platform download base or a URL
    field in the manifest, Apple secrets and `notarytool` in whichever repo
    hosts it, ~11 MB per arch per tag, and a pipeline step per upstream
    release — which would re-couple engine updates to our release cadence.
    `atomic-chat-conf` is an index of names and tags, not an artefact registry.
    Revisit only if we need to patch upstream macOS builds, or if Apple
    tightens execution policy for ad-hoc signatures.
  - The three `IS_MAC` short-circuits in `configureBackends` (persisted-value
    re-injection, disk recovery, stored-type clearing) are gone. They assumed
    macOS has exactly one backend that is always present; with a catalog that
    is no longer true, and the same code now runs on all three platforms.
    `refreshOptimalBackendCache` and `recheckOptimalBackend` keep theirs: macOS
    has one variant and no GPU tiers, so there is nothing to recommend. This
    work is about tags, not variants, and cross-family switching stays refused.
  - `BaseExtension.registerSettings` in `core/` used to let a stored
    `recommended` value overwrite the one a fresh registration carried. Only
    the extension can compute a recommendation, so the incoming value now wins
    when it exists and the stored one survives only when it does not. This is
    shared by both providers; without it the re-registration that follows a
    catalog refresh reinstates the previous recommendation.
- **Owner:** team
- **Links:** `extensions/llamacpp-upstream-extension/src/backend.ts`,
  `extensions/llamacpp-upstream-extension/src/index.ts`,
  `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`,
  `core/src/browser/extension.ts`,
  `Makefile` (`download-llamacpp-upstream-backend`),
  [`atomic-chat-conf/backends/manifest.json`](https://github.com/AtomicBot-ai/atomic-chat-conf/blob/main/backends/manifest.json),
  `docs/decisions/2026-08-12-follow-the-atomic-chat-conf-manifest-tag-for-upstream-llama-cpp.md`

<!--
Supersedes: 2026-05-19-ship-upstream-ggml-org-llama-cpp-as-a-second-macos-provider-no.md
(only the "Upstream backend updates ship only with Atomic Chat releases" clause)
-->

---
date: 2026-10-13
title: "Bundle the upstream llama.cpp release the pinned core would choose"
---

# 2026-10-13 — Bundle the upstream llama.cpp release the pinned core would choose

- **Context:** the release build bundled whatever tag atomic-chat-conf's `backends/manifest.json`
  named at build time ("the manifest is the gate", 2026-08-12), and every installed core followed
  that same single tag. atomic-chat-conf now lists upstream releases in
  `backends/llamacpp-upstream-releases.json`, each with the oldest core it runs on
  (`min_core_version`) and per-archive `candidate`/`approved`, and the core reads that list
  (core ADR 2026-10-13-read-upstream-llama-cpp-from-a-release-list). `manifest.json` stays for
  cores released before the list and moves only to a release every core runs. The extension's
  generated `bundledManifestBaseline.ts` was dead since the core took over the backend index
  (2026-09-27): only a test read it.
- **Decision:** `scripts/resolve-upstream-backend.mjs` picks from the release list the newest
  release that is not withdrawn, whose `min_core_version` the pinned core (`atomicCore.version`)
  meets and whose archive for the backend is approved — the build that core offers at runtime — and
  falls back to `manifest.json` while conf publishes no list. A `--tag` pin downloads from the
  mirror against its hash when the list carries it. `make sync-upstream-baseline` writes the list's
  fixture (`tests/fixtures/registries/upstream-releases.json`) instead of the extension baseline,
  which is removed. The `llamacpp-upstream` settings gain the core's `allow_candidate_builds`, handed
  to the core on change as `atomic-prism` does.
- **Consequences:** a release that needs a newer core is bundled only once the pin reaches that
  core, so a new installer and its catalog start on the same build. The resolver's output and its
  callers (Makefile, `release.yml`, `build-windows-release.ps1`) are unchanged. A release with no
  approved archive for a backend fails the build for that backend instead of shipping a candidate.
  The offline baseline is the core's alone.
- **Owner:** team
- **Links:** `scripts/resolve-upstream-backend.mjs`, `scripts/sync-upstream-baseline.mjs`,
  `tests/upstream-backend-resolver.test.mjs`, `tests/registry-contracts.test.mjs`,
  `extensions/llamacpp-upstream-extension/src/index.ts`, conf
  `.github/scripts/upstream-releases.mjs`.

<!--
Supersedes: 2026-08-12-follow-the-atomic-chat-conf-manifest-tag-for-upstream-llama-cpp.md (the bundled tag), 2026-08-13-generate-the-upstream-offline-baseline-from-the-manifest.md (the extension baseline)
-->

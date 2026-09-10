---
date: 2026-08-13
title: 'Generate the upstream offline baseline from the manifest'
---

# 2026-08-13 — Generate the upstream offline baseline from the manifest

- **Context:** After the manifest tag became authoritative (2026-08-12), one
  hand-maintained tag was left in the upstream driver:
  `LLAMACPP_UPSTREAM_PINNED_TAG = 'b10205'`, holding up
  `BUNDLED_MANIFEST_BASELINE` — the last-resort backend index used when all four
  network transports fail (ATO-243). Nothing forced it to move with
  `atomic-chat-conf`, so the offline path was silently a release or two behind,
  and a test asserted the drift by comparing the constant against a hardcoded
  newer tag. The same literal also anchored the test fixture that the registry
  contracts read, so fixture and baseline could disagree with each other as well
  as with the live manifest.
- **Decision:** `scripts/sync-upstream-baseline.mjs` (`make sync-upstream-baseline`)
  fetches the manifest and writes all three artefacts from it: the generated
  `bundledManifestBaseline.ts`, the `tests/fixtures/registries/upstream-manifest.json`
  fixture, and the pinned revision in `sources.json`. `BUNDLED_BASELINE_TAG` is
  derived from the generated module rather than declared next to it. `--check`
  fails when regeneration would change anything, which is how staleness is caught
  instead of being asserted.

  The baseline is emitted as TypeScript, not JSON, so the rolldown JSON-import
  configuration stays untouched. The ATO-243 invariant holds: the baseline is
  never written into `_cachedManifest`, or a single offline start would poison the
  cache for the rest of the session.
- **Consequences:**
  - The offline index is as fresh as the last regeneration, and refreshing it is
    one command rather than three coordinated edits. Divergence from the live
    manifest is checked in the opt-in live suite
    (`ATOMIC_TEST_LIVE_REGISTRIES=1`), not in `verify-fast` — a stale baseline is
    a reminder to regenerate, not a release blocker, because the live manifest
    wins whenever the network is up.
  - The fixture is now a generated file. Editing it by hand to make a test pass
    will be reverted by the next regeneration; add a synthetic fixture instead.
  - `GGML_ORG_CUDART_PINNED_TAG` in the TurboQuant driver remains a real
    hand-maintained pin. The cudart companions are not mirrored and that driver
    has no manifest field to follow, so it cannot be generated the same way; the
    stale "keep in sync with the upstream extension" comment now says so.
- **Owner:** team
- **Links:** `scripts/sync-upstream-baseline.mjs`,
  `extensions/llamacpp-upstream-extension/src/bundledManifestBaseline.ts`,
  `extensions/llamacpp-upstream-extension/src/backend.ts`,
  `tests/fixtures/registries/upstream-manifest.json`,
  `web-app/src/services/__tests__/external-contracts.test.ts`,
  `docs/decisions/2026-08-12-follow-the-atomic-chat-conf-manifest-tag-for-upstream-llama-cpp.md`

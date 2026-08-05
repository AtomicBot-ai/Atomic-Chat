---
date: 2026-08-05
title: "Resolve TurboQuant engines from a dynamic stable-release index instead of a pinned conf revision"
---

# 2026-08-05 — Resolve TurboQuant engines from a dynamic stable-release index instead of a pinned conf revision

- **Context:** The TurboQuant backend catalog was read from
  `atomic-chat-conf` at an immutable revision hardcoded in
  `extensions/llamacpp-extension/src/backend.ts`, and duplicated in `Makefile`,
  `.github/workflows/release.yml`, `scripts/dev-windows.ps1` and the test
  fixtures. Shipping a new engine release therefore took a conf PR *and* an
  Atomic Chat release, and macOS could not update its engine at all
  (`fetchRemoteBackends`, `reconcileBackendReleaseTag` and the auto-download in
  `ensureBackendReady` all bailed out early on non-Windows/Linux). Two further
  gaps: the fork publishes `dev-latest` and the legacy `turboquant-<id>-<sha>`
  tags as prereleases, which nothing explicitly rejected, and a clean install
  pinned the bundled CPU build in `config.version_backend` while showing the
  detected GPU tier in the dropdown — so a user who skipped onboarding stayed on
  CPU forever.
- **Decision:** The `llamacpp` provider resolves its catalog at runtime from
  `index.json`, published as an asset of each fork release and read through
  `releases/latest/download/`, with the fallback chain *index.json → the
  `/releases/latest` redirect → `atomic-chat-conf` at `main` → the disk cache →
  local installs*. No release tag exists as a literal in the app or in the build
  scripts; `TURBOQUANT_TAG` is the single override for reproducible CI builds.
  Only stable releases of the unified `b<N>-X.Y.Z` scheme are installable —
  anything else, including a redirect that lands on a prerelease, is rejected at
  parse time — and a release whose `min_app_version` exceeds the running app is
  hidden from both the dropdown and auto-update. macOS joins the same runtime
  update path, with the bundled build demoted to an offline baseline and
  force-switch reduced to "the bundled build genuinely supersedes the current one
  of the same type". On first run with no user choice, the hardware-optimal
  variant is fetched immediately while the bundled build keeps serving.
- **Consequences:** Publishing an engine release now reaches every user,
  including macOS, without an Atomic Chat release or a conf edit; the dropdown
  labels releases by accelerator family and highlights rather than by archive id.
  The costs are deliberate: a clean install on a discrete-NVIDIA host starts a
  several-hundred-megabyte CUDA download unasked (which the next stage's
  `parts[]` split is meant to shrink), and the app now trusts a document served
  from the fork's release CDN — integrity rests on HTTPS plus an owner/asset-name
  allowlist until `sha256` from the index is enforced. `min_app_version` is the
  only guard against a release whose `llama-server` CLI has drifted from
  `tauri-plugin-llamacpp/src/args.rs`, so the fork must set it on every breaking
  flag change. Unknown fields (`parts[]`, `requires{}`) are ignored rather than
  rejected, so the split-artifact stage needs no protocol change. This supersedes
  the conf-revision resolution mechanism of the 2026-06-23, 2026-07-28 and
  2026-07-31 ADRs for the `llamacpp` provider only; `llamacpp-upstream`,
  `backends/manifest.json` and `GGML_ORG_CUDART_PINNED_TAG` stay pinned exactly
  as before.
- **Owner:** team
- **Links:** the 2026-06-23 ADR *Ship the TurboQuant `llamacpp` provider on
  Windows + Linux …*, the 2026-07-28 ADR *Pin backend artifacts to verified
  tags*, the 2026-07-31 ADRs *Adopt unified TurboQuant release tags …* and
  *Reconcile the TurboQuant release tag automatically on app update*, the
  2026-06-15 ADR on never recording a failed detection as a CPU preference,
  [fork releases](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases),
  `extensions/llamacpp-extension/src/backend.ts`,
  `extensions/llamacpp-extension/src/index.ts`,
  `scripts/resolve-turboquant-release.sh`, `Makefile`,
  `.github/workflows/release.yml`, `scripts/dev-windows.ps1`,
  `tests/fixtures/registries/turboquant-index.json`,
  `tests/registry-contracts.test.mjs`

<!--
Supersedes: 2026-07-31-adopt-unified-turboquant-releases-and-expand-linux-backends.md
-->

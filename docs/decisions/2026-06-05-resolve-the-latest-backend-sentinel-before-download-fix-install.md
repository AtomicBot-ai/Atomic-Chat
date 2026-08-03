---
date: 2026-06-05
title: "Resolve the `latest/<backend>` sentinel before download + fix \"Install from file\" on Windows/Linux `llamacpp-upstream` (ATO-95)"
---

# 2026-06-05 — Resolve the `latest/<backend>` sentinel before download + fix "Install from file" on Windows/Linux `llamacpp-upstream` (ATO-95)

- **Context:** A Windows user (Discord, via [ATO-95](https://linear.app/atomicchat/issue/ATO-95-windows-skachivanie-llamacpp-cpu-bekenda-padaet-bityj-url-s-latest))
  could not download the llama.cpp CPU backend, and the "Install from file"
  button did nothing. Two independent bugs in the `llamacpp-upstream`
  provider:
  - **Bug 1 — literal `latest` in the download URL → 404.** The static
    "Latest <variant>" dropdown entries carry a `latest/<backend>` sentinel
    (`extensions/llamacpp-upstream-extension/src/index.ts`), which MUST be
    resolved to a concrete ggml-org release tag (`bXXXX`) before download —
    ggml-org has no `latest` release tag (the `latest` keyword is valid only
    for the `/releases/latest` HTML page, not the `/releases/download/<tag>/…`
    asset path). Resolution existed in `downloadManualBackend()` /
    `onSettingUpdate()` but **not** in the
    `downloadRecommendedBackend → downloadAndInstallBackend →
    getBackendDownloadUrl` path used by onboarding (`SetupBackendStep`) and
    the "Find optimal backend" button. `recheckOptimalBackend()` also
    hard-coded a `|| 'latest'` fallback, and neither `getBackendDownloadUrl`
    nor `downloadAndInstallBackend` guarded against `version === 'latest'` —
    they silently built `…/releases/download/latest/llama-latest-bin-win-cpu-x64.zip`
    (verified 404 against the live GitHub API 2026-06-05; current tag `b9529`,
    correct asset `llama-b9529-bin-win-cpu-x64.zip`).
  - **Bug 2 — "Install from file" no-op on Windows/Linux.**
    `handleInstallBackendFromFile` (`web-app/src/routes/settings/providers/$providerName.tsx`)
    early-returned unless the provider was `llamacpp` or `mlx`, but the local
    provider id on Windows/Linux is `llamacpp-upstream` (`LOCAL_LLAMACPP_PROVIDER`).
    The button is rendered for it, so the click hit the guard and bailed.
- **Decision:** Implement the ticket's three-part fix for Bug 1 plus the
  one-line allowlist fix for Bug 2.
  - `downloadRecommendedBackend` now resolves a leading `latest/<backend>`
    sentinel up front via `resolveLatestBackendString()` (ggml-org release
    lookup), falling back to `newestInstalledOfFamily()` (newest locally
    installed copy) when the release stream is unreachable, and throws when
    neither yields a concrete tag — mirroring `downloadManualBackend`.
  - `recheckOptimalBackend`'s `|| 'latest'` fallback is removed: when
    `listSupportedBackends()` / `findLatestVersionForBackend()` come up empty
    it now calls `resolveLatestBackendString(idealType)`; only if that also
    fails does it reuse the **current** backend's concrete tag, and it
    returns `null` (no recommendation) rather than ever emitting a `latest`
    tag when there is no current tag to borrow.
  - Defense-in-depth: `getBackendDownloadUrl` (`backend.ts`) and
    `downloadAndInstallBackend` (`index.ts`) now `throw` on
    `version === 'latest'` instead of building a 404 URL.
  - Bug 2: the `handleInstallBackendFromFile` guard accepts
    `LOCAL_LLAMACPP_PROVIDER` (already imported in the file); the success
    toast's display name no longer mislabels the upstream provider as "MLX".
- **Consequences:**
  - Onboarding and "Find optimal backend" download a concrete `bXXXX`
    backend on Windows/Linux instead of dead-ending on a 404; offline /
    rate-limited hosts fall back to the newest locally-installed copy or fail
    with an actionable error rather than a silent bad URL. "Install from file"
    works for `llamacpp-upstream`. The `installBackend` hook already resolves
    the platform-active extension via `LOCAL_LLAMACPP_EXTENSION_NAME`, so no
    downstream change was needed.
  - Pure TS/UI change; no Rust, no IPC, no on-disk layout, no settings schema
    changes. macOS (turboquant `llamacpp` provider) is unaffected. ReadLints
    clean on all three files; standalone `tsc`/`rolldown`/`vitest` runs in
    this env resolve to the root workspace config (pre-existing, unrelated
    failures) and are not authoritative for these scoped edits.
- **Owner:** team.
- **Links:** [ATO-95](https://linear.app/atomicchat/issue/ATO-95-windows-skachivanie-llamacpp-cpu-bekenda-padaet-bityj-url-s-latest),
  §4.2 *LLM backend*, the 2026-05-22 ADR *Windows ships only `llamacpp-upstream`*,
  files: [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
  (`downloadRecommendedBackend`, `recheckOptimalBackend`, `downloadAndInstallBackend`),
  [`extensions/llamacpp-upstream-extension/src/backend.ts`](extensions/llamacpp-upstream-extension/src/backend.ts)
  (`getBackendDownloadUrl`),
  [`web-app/src/routes/settings/providers/$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx)
  (`handleInstallBackendFromFile`).

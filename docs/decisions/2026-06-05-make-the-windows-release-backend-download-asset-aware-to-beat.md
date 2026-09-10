---
date: 2026-06-05
title: "Make the Windows release backend download asset-aware to beat the ggml-org \"tag-marked-latest-before-asset-uploaded\" race (ATO-95, CI)"
---

# 2026-06-05 — Make the Windows release backend download asset-aware to beat the ggml-org "tag-marked-latest-before-asset-uploaded" race (ATO-95, CI)

- **Context:** The `build-windows` job's inline "Download upstream llamacpp
  backend" step in [`.github/workflows/release.yml`](.github/workflows/release.yml)
  failed with `curl: (22) … 404` on
  `…/releases/download/b9530/llama-b9530-bin-win-cpu-x64.zip`. Root cause is a
  **publish race** in the ggml-org/llama.cpp release stream, not a bad tag:
  GitHub Actions on the upstream side creates the `bXXXX` tag and marks it
  "latest" the instant the release is created, but uploads the per-platform
  assets (macOS, Linux, then Windows `.zip`s) over the following minutes. The
  CI step resolved `GET /releases/latest` → `b9530`, then **blindly** built
  `llama-b9530-bin-win-cpu-x64.zip` and `curl -fSL`'d it — hitting the window
  where the tag exists but the Windows asset has not finished uploading
  (verified: at failure time the GitHub UI showed b9530 "Show all 23 assets
  Loading" with the Windows zip absent; minutes later the same asset URL
  returned 302→200). The runtime extension is **already** immune — its
  `fetchRemoteBackends()` only returns backends whose asset is actually present
  in the release JSON, so the prior-turn `resolveLatestBackendString` fix
  degrades gracefully — but the CI shell step trusted the tag alone.
- **Decision:** Resolve the tag **asset-aware** instead of trusting
  `/releases/latest`. The step now lists
  `GET /releases?per_page=20` and picks, via `jq`, the **newest non-draft /
  non-prerelease release whose `assets[].name` already contains
  `llama-<tag>-bin-win-cpu-x64.zip`** (`_resolve_tag`). A too-fresh release
  whose Windows asset is still uploading is skipped in favour of the previous
  fully-published one. The retry/​auth helpers (`_gh_get` / `_gh_fetch`) are
  unchanged; `_tag_ok` (top-level `.tag_name` probe, invalid for a list
  response) is replaced by `_release_ok` (non-empty JSON array). The asset
  download itself gains `--retry 5 --retry-delay 3` for transient-network
  resilience (404 no longer reachable since the asset is verified present).
- **Consequences:**
  - The Windows release build no longer 404s during the upstream asset-upload
    window; on the rare run that catches a brand-new tag mid-upload it bundles
    the previous release's `win-cpu-x64` build (one build older, fully valid)
    instead of failing. `per_page=20` is ample — every ggml-org release ships
    `win-cpu-x64`.
  - **Scope: every build-time backend-download site that trusted the tag was
    hardened the same way** (the failing `build-windows` inline step *plus* all
    its siblings, since they share the identical latent defect and the same
    upstream release stream):
    1. [`.github/workflows/release.yml`](.github/workflows/release.yml) —
       `build-windows` inline step (the one that actually 404'd). Asset-aware
       `jq` resolver (`_resolve_tag`), `_tag_ok` → `_release_ok` (array check),
       `curl --retry 5 --retry-delay 3`.
    2. [`Makefile`](Makefile) `download-llamacpp-upstream-backend` — **all three
       branches** (macOS `…-bin-<macos-arch>.tar.gz`, Windows
       `…-bin-<backend>.zip`, Linux `…-bin-ubuntu-x64.tar.gz`). Each `else`
       (fetch-latest) path now lists `?per_page=20`, resolves via the inline
       asset-aware `jq`, and the asset `curl` gains `--retry`. The
       `LLAMACPP_UPSTREAM_TAG` pin path is **untouched** (trust an explicit
       pin, no asset check). `_tag_ok` body switched to a non-empty-array probe
       in all three branches.
    3. [`Makefile`](Makefile) `download-llamacpp-upstream-backend-win-cpu`
       (PowerShell) — `Invoke-RestMethod` now lists releases and `foreach`-picks
       the newest carrying `llama-<tag>-bin-win-cpu-x64.zip`, plus a 5-try
       `Invoke-WebRequest` retry loop.
    4. [`scripts/build-windows-release.ps1`](scripts/build-windows-release.ps1)
       and [`scripts/dev-windows.ps1`](scripts/dev-windows.ps1) — same
       asset-aware `foreach` resolution + download retry loop (dev-windows keys
       the asset name off its auto-detected `$backend`).
    A too-fresh release whose target asset is still uploading is skipped in
    favour of the previous fully-published one; `per_page=20` is ample since
    every ggml-org release ships these assets.
  - Pure build/CI change; no app code, no Rust, no bundled-artefact layout
    change. The `LLAMACPP_UPSTREAM_TAG` override semantics are preserved.
    Verified: `release.yml` YAML parses (ruby + js-yaml); `make -n` confirms the
    three bash branches and the PowerShell target expand correctly (`$$`→`$`,
    jq program intact, retry flags present); the `jq` resolver run against the
    live GitHub API returns `b9530` (newest release actually carrying the
    asset). `pwsh` is unavailable on the dev host, so the two standalone `.ps1`
    scripts were validated by expansion/brace review, not execution.
- **Owner:** team.
- **Links:** [ATO-95](https://linear.app/atomicchat/issue/ATO-95-windows-skachivanie-llamacpp-cpu-bekenda-padaet-bityj-url-s-latest),
  the prior 2026-06-05 ADR *Resolve the `latest/<backend>` sentinel …*,
  the 2026-05-22 ADR *Windows ships only `llamacpp-upstream`*,
  [ggml-org/llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases),
  files: [`.github/workflows/release.yml`](.github/workflows/release.yml)
  (`build-windows` step), [`Makefile`](Makefile)
  (`download-llamacpp-upstream-backend` ×3 branches +
  `download-llamacpp-upstream-backend-win-cpu`),
  [`scripts/build-windows-release.ps1`](scripts/build-windows-release.ps1),
  [`scripts/dev-windows.ps1`](scripts/dev-windows.ps1).

---
date: 2026-06-17
title: "Resolve the `llamacpp-upstream` backend *index* from a static `atomic-chat-conf` manifest (raw.githubusercontent.com) instead of the rate-limited `api.github.com` (ATO-199)"
---

# 2026-06-17 — Resolve the `llamacpp-upstream` backend *index* from a static `atomic-chat-conf` manifest (raw.githubusercontent.com) instead of the rate-limited `api.github.com` (ATO-199)

- **Context:** `fetchRemoteBackends()` in
 [`extensions/llamacpp-upstream-extension/src/backend.ts`](extensions/llamacpp-upstream-extension/src/backend.ts)
 hit `https://api.github.com/repos/ggml-org/llama.cpp/releases/latest`
 **unauthenticated** to learn which backend builds exist. GitHub's
 unauthenticated REST limit is 60 req/hr **per IP**, which is shared/NAT/VPN
 networks exhaust quickly → `403` → the function returns `[]` → a *fresh*
 install dead-ends with no GPU backend resolvable and no locally-installed
 fallback yet ([ATO-199](https://linear.app/atomicchat/issue/ATO-199)). The
 archive *downloads* themselves go through the ggml-org CDN
 (`github.com/.../releases/download`, `LLAMACPP_DOWNLOAD_BASE`) which is **not**
 rate-limited — only the *index lookup* was the choke point.
- **Decision (hotfix; Windows + Linux x64 only — macOS is bundle-only and early
 `return []`s in `fetchRemoteBackends`, never touching the index):** Move the
 index lookup off `api.github.com` onto a **static manifest** committed to our
 existing config repo `AtomicBot-ai/atomic-chat-conf`, served via
 `raw.githubusercontent.com` (no per-IP rate limit — same channel the
 model/provider/recommended registries already use). The manifest
 **mirrors the GitHub release shape** (`{ tag_name, assets: [{ name }] }`) so
 the client's per-OS asset-name regex + Windows/Linux whitelist parser is
 reused **verbatim** — the only change is the source URL.
 1. **atomic-chat-conf:** new `backends/manifest.json` seeded with the newest
 *complete* ggml-org release (`b9691`, 8 Windows/Linux assets: cpu /
 cuda-12.4 / cuda-13.3 / vulkan win + ubuntu cpu/vulkan + 2 cudart
 companions). New `backends/schema.json` (Draft-07, mirrors the
 `models/`/`providers/` schema style incl. `format: date-time`), a
 `Validate backends manifest` + integrity-check pair in
 [`.github/workflows/validate.yml`](https://github.com/AtomicBot-ai/atomic-chat-conf)
 (ajv `--strict=false` + a node check: tag shape `^b\d+$`, unique
 non-empty asset names, and every `llama-*` asset carries the declared tag
 so the client regex matches), and a `README.md` `backends/` section.
 2. **Extension:** `LLAMACPP_RELEASES_API` → `LLAMACPP_BACKEND_MANIFEST_URL`
 (`raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/manifest.json`);
 `fetchRemoteBackends` swaps only the request URL (transport `tauriFetch`,
 `User-Agent`, `buildHttpProxyOptions()`, timeouts, and all downstream
 parsing unchanged); the dead macOS-branch `void LLAMACPP_RELEASES_API` is
 removed. `getBackendDownloadUrl` / `getCudartDownloadUrl` (CDN) untouched.
- **Consequences:** Fresh installs on shared/NAT/VPN networks resolve the
 backend catalog without burning the GitHub anon quota; the `[]`-on-failure
 contract is preserved, so the existing offline floors
 (`newestInstalledOfFamily`, `resolveBackendFallback`, bundled `win-cpu-x64`)
 and `detection-failed` UX still apply when raw is unreachable.
 **Deliberately NOT done (next phase):** the manifest is **static and
 hand-edited** — it can lag new ggml-org releases until a cron auto-generator
 (de-pinning CUDA minors) is added; a last-good disk-cache of the manifest
 (PR #84 part 4) and differentiated error classification
 (`rate_limited`/`timeout`/`offline`) + `backend_resolve_failed` telemetry
 (PR #81/#84) are out of this slice. Chosen over PR #84's approach (host the
 manifest as a release-asset in the *main* repo + cron) because reusing the
 already-working `atomic-chat-conf` raw channel needs no new release-asset or
 CI to ship the hotfix. **Verified:** rolldown `build` clean
 (`dist/index.js` 227 kB, exit 0 — authoritative compile); 5 new
 `backend.test.ts` cases pass (URL = raw not `api.github.com`; Windows
 catalog cpu/cuda-12.4/cuda-13.3/vulkan, cudart not surfaced; Linux
 cpu+vulkan; macOS `[]` with **no** network call; `[]` on fetch failure) —
 the 4 other failures in that suite (`getBackendDir`/`isBackendInstalled`
 `llamacpp` vs `llamacpp-upstream` path) are **pre-existing** (confirmed by a
 stash baseline); `eslint` clean on both edited files; conf `manifest.json` +
 `schema.json` valid (ajv `--strict=false`, matching CI) and the integrity
 check passes (tag `b9691`, 8 assets). Standalone `tsc --noEmit` on the
 extension shows only the documented pre-existing module-resolution / base-class
 noise (no new errors from the URL swap).
- **Amendment (same day) — extend the manifest source to the *build-time*
 `Makefile` download (Windows + Linux), so a Windows/Linux rebuild also stops
 hitting `api.github.com`.** The runtime fix above only covered the in-app
 `fetchRemoteBackends` index lookup; the build-side
 `download-llamacpp-upstream-backend` target (and the PowerShell
 `download-llamacpp-upstream-backend-win-cpu` target) in
 [`Makefile`](Makefile) still resolved the tag/asset by querying
 `api.github.com/repos/ggml-org/llama.cpp/releases` — the same rate-limited
 choke point, just at build time — so a fresh `make`/`yarn download:bin` on a
 shared/NAT/VPN host (or in CI without `GH_TOKEN`) could still 403. Both the
 **Windows** (`ifeq ($(OS),Windows_NT)`) and **Linux**
 (`ifeq ($(shell uname -s),Linux)`) branches of
 `download-llamacpp-upstream-backend` now `curl … --retry 5 --retry-delay 3`
 the **same static manifest**
 (`raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/manifest.json`)
 into a `mktemp` temp file and resolve `tag_name` + the per-platform asset with
 `jq` against the single manifest object (Windows keeps the family→highest-minor
 CUDA resolution, e.g. `win-cuda-13-x64` → `b9691 win-cuda-13.3-x64`, from the
 2026-06-16 ADR; Linux matches `llama-<tag>-bin-<infix>.tar.gz`). The
 `download-llamacpp-upstream-backend-win-cpu` PowerShell target swaps its
 `Invoke-RestMethod` from the releases API to the manifest and finds the
 `win-cpu-x64` asset in the single object. The `GH_TOKEN`/`_gh_fetch`/`_tag_ok`
 GitHub-list machinery is dropped from these branches (raw needs no auth); the
 archive *downloads* still come from the ggml-org CDN. **The macOS branch is
 deliberately left on `api.github.com`** — macOS is bundle-only, its assets
 (`macos-arm64`/`macos-x64`) are **not** in the manifest, and it re-codesigns
 the upstream tarball per the 2026-05-19 ADR; pinning it to the
 Windows/Linux-scoped manifest would break the macOS build. **Verified:**
 `make -n download-llamacpp-upstream-backend` parses clean on the macOS host
 (Darwin branch expands as before); the exact Windows/Linux `jq` resolvers were
 run against the live manifest fixture → `win-cuda-13-x64`→`b9691 win-cuda-13.3-x64`,
 `win-cuda-12-x64`→`b9691 win-cuda-12.4-x64`, `win-cpu-x64`/`win-vulkan-x64`/
 `ubuntu-x64`/`ubuntu-vulkan-x64`→`b9691`, and a non-existent `win-cuda-11-x64`
 family → empty (correctly aborts the build). A live Windows/Linux build was
 **not** executed (no such host in the sandbox).
- **Owner:** team.
- **Links:** [ATO-199](https://linear.app/atomicchat/issue/ATO-199),
 [PR #84](https://github.com/AtomicBot-ai/Atomic-Chat/pull/84) (alternative,
 superseded by this approach), the 2026-05-27 ADR *Replace `janhq/model-catalog`
 … with curated `atomic-chat-model-catalog`* (raw-channel precedent), the
 2026-06-16 ADR *Tiered graceful backend fallback …* (offline floors this
 relies on), §4.2 *LLM backend*, files:
 [`extensions/llamacpp-upstream-extension/src/backend.ts`](extensions/llamacpp-upstream-extension/src/backend.ts)
 (`LLAMACPP_BACKEND_MANIFEST_URL`, `fetchRemoteBackends`),
 [`extensions/llamacpp-upstream-extension/src/test/backend.test.ts`](extensions/llamacpp-upstream-extension/src/test/backend.test.ts),
 [`Makefile`](Makefile) (`download-llamacpp-upstream-backend`
 Windows/Linux branches + `download-llamacpp-upstream-backend-win-cpu`),
 `atomic-chat-conf` `backends/manifest.json` + `backends/schema.json` +
 `.github/workflows/validate.yml` + `README.md`.

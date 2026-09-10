---
date: 2026-06-26
title: "Fix Linux/Vulkan GPU backend 404 → infinite spinner when manifest tag is stale or CDN asset is missing (ATO-233)"
---

# 2026-06-26 — Fix Linux/Vulkan GPU backend 404 → infinite spinner when manifest tag is stale or CDN asset is missing (ATO-233)

- **Context:** On Linux + Vulkan, model loads hung indefinitely on the spinner.
 Root cause: the static `atomic-chat-conf/backends/manifest.json` contained tag
 `b9691` which did not have a live `llama-b9691-bin-ubuntu-vulkan-x64.tar.gz`
 asset on the ggml-org CDN (404). Four compounding code bugs amplified the
 outage: (1) `ensureBackendReady` always attempted the stale-tag download before
 checking whether a compatible backend of the same type was already installed
 locally at a different tag; (2) `load()` skipped `configureBackends` whenever
 `version_backend` was a concrete `<tag>/<backend>` string, even when that exact
 backend was not on disk — so configureBackends had no chance to update the
 stale pin; (3) `installBackend` ("Install Backend from File") stored backends
 under the raw ggml-org asset name (`ubuntu-vulkan-x64`) instead of the internal
 id (`linux-vulkan-x64`), so `findCompatibleInstalledBackend('linux-vulkan-x64')`
 could not find manually-installed backends; (4) `map_old_backend_to_new` had no
 mapping for `ubuntu-*` names, so the naming mismatch propagated to all callers
 that used the normalization function. The `reqwest` client in `_get_file_size`
 also lacked a connection timeout, allowing a hung CDN endpoint to hold the load
 promise open indefinitely.
- **Decision (four minimal, independent fixes):**
 1. **`ensureBackendReady` local-first pre-flight** (most impactful, ATO-233
 primary fix). On the load path (`allowFallback=true`), before attempting any
 network download, check if a compatible backend of the same type is already
 installed locally at a different tag via `findCompatibleInstalledBackend`.
 If found, persist the local version as the new `version_backend` and return
 immediately — eliminates the stale-tag 404 entirely when a working local copy
 exists.
 2. **`load()` awaits configureBackends when backend is not installed.** In
 `load()`, the existing "skip wait when concrete" shortcut now has an exception:
 if the concrete `version_backend` is not locally installed (`isBackendInstalled`
 returns false), we still await `configureBackendsPromise`. This lets
 configureBackends finish and potentially update `version_backend` to an
 installed backend before the load races ahead with a stale tag.
 3. **`installBackend` normalizes `ubuntu-*` → `linux-*`** on Linux. When the
 archive filename is `llama-bXXXX-bin-ubuntu-vulkan-x64.tar.gz` (ggml-org
 upstream naming), the extracted backend is now stored under `linux-vulkan-x64`
 (the internal id). Future "Install Backend from File" installs will be found
 by `findCompatibleInstalledBackend` and the rest of the backend machinery.
 4. **`map_old_backend_to_new` (Rust) maps `ubuntu-*` → `linux-*`** so that
 any existing on-disk backend stored under the old ubuntu name is normalized
 to the corresponding `linux-*` id whenever it passes through the mapping
 function (e.g., in `find_latest_version_for_backend`, stored-type comparisons,
 etc.). **`findCompatibleInstalledBackend` (TS)** extended with an
 `ubuntu-*` ↔ `linux-*` equivalence set so it can find manually-installed
 backends regardless of which naming generation they used.
 5. **`_get_client_for_item` + `_get_file_size` timeouts** (defense-in-depth).
 Added `connect_timeout(30s)` to the reqwest client builder and a per-request
 `.timeout(30s)` on the HEAD request in `_get_file_size`, capping the
 worst-case hang from a non-responsive CDN endpoint.
- **Consequences:** On Linux with a stale manifest tag: if the user has any
 `linux-vulkan-x64` backend already installed (from a previous "Find optimal
 backend" or "Install from File" run), the model load now uses it immediately
 without a network round-trip. If no Vulkan backend is installed, the load still
 falls through to Tier 3 (CPU fallback) after at most 30 seconds instead of
 potentially forever. Future "Install from File" installs with ggml-org ubuntu
 names are stored under the correct internal id. **Deliberately NOT done:** the
 manifest update itself (a separate data-only change in `atomic-chat-conf` to
 bump `b9691` → a tag that actually has the ubuntu-vulkan-x64 asset); that is
 tracked as a follow-up data fix. **Verified:** rolldown build clean
 (`dist/index.js` 216.79 kB, exit 0 — the authoritative compile); Rust backend
 tests not runnable in the sandbox (Cargo 1.83 is below the dependency floor of
 some new transitive deps), consistent with prior ADRs; `eslint` runs on
 web-app without new errors; all logic verified by code-level inspection.
- **Owner:** team.
- **Links:** [ATO-233](https://linear.app/atomicchat/issue/ATO-233), the
 2026-06-17 ADR *Resolve the `llamacpp-upstream` backend index from a static
 manifest* (ATO-199; the manifest-channel this fix builds on), the 2026-06-16
 ADRs *Tiered graceful backend fallback* (ATO-178/179; the resolveBackendFallback
 tiers that this pre-flight sits in front of), files:
 [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
 (`ensureBackendReady` local-first pre-flight, `load()` configureBackends wait,
 `installBackend` ubuntu→linux normalization),
 [`extensions/llamacpp-upstream-extension/src/backend.ts`](extensions/llamacpp-upstream-extension/src/backend.ts)
 (`backendTypeEquivalents`, `findCompatibleInstalledBackend`),
 [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs)
 (`map_old_backend_to_new` ubuntu-* handling),
 [`src-tauri/src/core/downloads/helpers.rs`](src-tauri/src/core/downloads/helpers.rs)
 (`_get_client_for_item` connect_timeout, `_get_file_size` per-request timeout).

---

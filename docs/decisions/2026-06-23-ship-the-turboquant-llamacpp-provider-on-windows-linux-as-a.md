---
date: 2026-06-23
title: "Ship the TurboQuant `llamacpp` provider on Windows + Linux as a second provider (side-by-side with `llamacpp-upstream`), resolving the backend index from a static `atomic-chat-conf` turboquant manifest (per-backend tag) and downloading GPU variants at runtime from the `AtomicBot-ai/atomic-llama-cpp-turboquant` releases CDN"
---

# 2026-06-23 — Ship the TurboQuant `llamacpp` provider on Windows + Linux as a second provider (side-by-side with `llamacpp-upstream`), resolving the backend index from a static `atomic-chat-conf` turboquant manifest (per-backend tag) and downloading GPU variants at runtime from the `AtomicBot-ai/atomic-llama-cpp-turboquant` releases CDN

- **Context:** Our `atomic-llama-cpp-turboquant` fork now publishes
 Windows (`cpu` / `vulkan` / `cuda-12.4` / `cuda-13.3`) and Linux
 (`vulkan`, with built-in CPU fallback via `GGML_BACKEND_DL`) builds, on top
 of the existing macOS `arm64` build. Until now the turboquant `llamacpp`
 provider (`@janhq/llamacpp-extension` + `tauri-plugin-llamacpp`) was
 **macOS-only**: the 2026-05-22 ADR *Windows ships only `llamacpp-upstream`*
 and the 2026-05-28 ADR *Linux ships only `llamacpp-upstream`* excluded it
 from the Windows/Linux installer bundles (`package.json ::
 build:extensions:{win32,linux}` carried `--exclude
 @janhq/llamacpp-extension`), gated the whole flow behind `IS_MAC` in the
 extension, and `fetchRemoteBackends` early-`return []`'d off macOS. Two facts
 about the turboquant release stream forced the index-resolution shape:
 (1) **the releases are scattered — each variant is its OWN GitHub release
 with its OWN tag** (all on the same SHA, e.g. `d86eb0b`: tags
 `turboquant-windows-x64-cpu-d86eb0b`, `turboquant-windows-x64-cuda-12.4-…`,
 `turboquant-linux-x64-vulkan-…`, …), so a `/releases/latest` lookup is
 useless and a `/releases` list scan would hammer the rate-limited
 `api.github.com` (the exact problem the 2026-06-17 ATO-199 ADR solved for
 upstream); and (2) the Windows CUDA zips **already bundle**
 `cudart64`/`cublas64`/`cublasLt64` DLLs, so the janhq-style separate-cudart
 download is unnecessary.
- **Decision (per the user-chosen options — `side_by_side` provider,
 `download_variants` runtime delivery, `clean` release-aligned id scheme):**
 1. **Clean backend-ID scheme** (directly mirrors the release asset names):
 `windows-x64-cpu`, `windows-x64-cuda-12.4`, `windows-x64-cuda-13.3`,
 `windows-x64-vulkan`, `linux-x64-vulkan`, `macos-arm64`. Asset =
 `llama-turboquant-<id>.zip` (Windows) / `.tar.gz` (Linux/macOS); per-id
 tag prefix = `turboquant-<id>`.
 2. **Static turboquant manifest in `atomic-chat-conf`** (extends the
 2026-06-17 ATO-199 channel precedent). New `backends/turboquant-manifest.json`
 (`{ $schema, updated_at, commit, backends: [{ id, tag, asset }] }`, seeded
 from the `d86eb0b` set — 4 Windows ids + `linux-x64-vulkan`) +
 `backends/turboquant-schema.json` (Draft-07) + a `Validate turboquant
 manifest` ajv job and a node integrity check in
 [`.github/workflows/validate.yml`](https://github.com/AtomicBot-ai/atomic-chat-conf)
 (every `tag` starts `turboquant-<id>`, asset matches
 `llama-turboquant-<id>.(zip|tar.gz)`, ids unique). **The only structural
 difference from the upstream manifest** (single `tag_name` + `assets`) is
 that **each turboquant entry carries its own `tag`**, because the variants
 live in different releases. The archive *downloads* still come from the
 releases CDN (`github.com/.../releases/download`, not rate-limited).
 3. **Rust** ([`tauri-plugin-llamacpp/src/backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs)):
 `determine_supported_backends` rewritten to the clean ids
 (windows/x86_64 → always `windows-x64-cpu` + conditionally
 `windows-x64-cuda-13.3` / `-cuda-12.4` / `-vulkan`; linux/x86_64 → always
 `linux-x64-vulkan`; macOS keeps `macos-arm64`);
 `get_backend_category` / `prioritize_backends` / `map_old_backend_to_new`
 (maps persisted legacy janhq ids onto the clean ids) /
 `is_cuda_installed` (cudart lives in the backend's own `build/bin`, no
 janhq migration path) updated; the `#[cfg(test)]` matrix asserts the new
 ids (33 backend tests green).
 4. **TS** ([`extensions/llamacpp-extension/src/backend.ts`](extensions/llamacpp-extension/src/backend.ts)):
 new `TURBOQUANT_BACKEND_MANIFEST_URL`
 (`raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/turboquant-manifest.json`);
 `fetchRemoteBackends` drops the `IS_MAC → []` early return, fetches the
 manifest (tauriFetch + `globalThis.fetch` fallback race, mirroring the
 upstream helper), keeps entries whose `id` is in the hardware-supported set,
 and emits `{ version: entry.tag, backend: entry.id }` (`[]` on any failure
 — preserves the offline-fallback contract); `getBackendDownloadUrl` builds
 `${BASE}/${tag}/llama-turboquant-${id}.${zip|tar.gz}`; the cudart companion
 logic (`getCudartDownloadUrl`/`CUDART_*`) is removed; `listSupportedBackends`
 now applies the hardware gate on Linux too.
 [`index.ts`](extensions/llamacpp-extension/src/index.ts): `IS_MAC` gates
 around `configureBackends`/`ensureBackendReady` removed, `ensureCudartReady`
 skipped for turboquant, bundled-fallback install wired for Win
 (`windows-x64-cpu`) / Linux (`linux-x64-vulkan`).
 5. **Build & bundling:** [`package.json`](package.json) un-excludes
 `@janhq/llamacpp-extension` on `build:extensions:{win32,linux}` (the
 turboquant `.tgz` now ships in `pre-install/`);
 `resources/llamacpp-backend/**/*` added to
 [`tauri.windows.conf.json`](src-tauri/tauri.windows.conf.json) +
 [`tauri.linux.conf.json`](src-tauri/tauri.linux.conf.json);
 [`Makefile`](Makefile) `download-llamacpp-backend` Windows/Linux branches
 now resolve `tag`+`asset` from the turboquant manifest
 (`curl … --retry 5 --retry-delay 3` + `jq`, or PowerShell
 `Invoke-RestMethod` in the new `download-llamacpp-backend-win-cpu` target)
 and pull the bundled offline fallback (`windows-x64-cpu` / `linux-x64-vulkan`)
 from the releases CDN into `resources/llamacpp-backend/build/bin`.
 6. **CI** ([`.github/workflows/release.yml`](.github/workflows/release.yml)):
 `build-windows` gains a manifest-driven `windows-x64-cpu` download step
 (inline bash + `jq` — not `make …-win-cpu`, whose PowerShell `$(...)` is
 mangled by make's `/usr/bin/sh`); `build-linux-x64` calls
 `make download-llamacpp-backend` for `linux-x64-vulkan`.
 7. **web-app** ([`web-app/src/lib/utils.ts`](web-app/src/lib/utils.ts)):
 `getProviderTitle('llamacpp')` now unconditionally returns `'Atomic
 Llama.cpp Turboquant'` (the `IS_WINDOWS/IS_LINUX → 'Llama.cpp'` vestige is
 gone). `LOCAL_LLAMACPP_PROVIDER` stays `'llamacpp-upstream'` (default
 unchanged); `getModelToStart` order already lists turboquant second.
- **Consequences:** Windows and Linux now show **two** llama.cpp providers —
 the default `llamacpp-upstream` plus the secondary "Atomic Llama.cpp
 Turboquant" — exactly like macOS. Turboquant GPU variants download at
 runtime from the releases CDN (CUDA zips carry their own cudart); the
 bundled `windows-x64-cpu` / `linux-x64-vulkan` build is the always-available
 offline fallback. Both providers share the GGUF tree
 (`MODELS_PROVIDER_ROOT='llamacpp'`); backend binaries and settings stay
 isolated per provider. Updating turboquant to a new commit = edit one
 manifest file in `atomic-chat-conf` (no app release, no `api.github.com`).
 **This supersedes the Windows-only / Linux-only `llamacpp-upstream`
 clauses of the 2026-05-22 and 2026-05-28 ADRs** (upstream remains the
 *default* provider on both, but turboquant is no longer excluded) and
 **extends the manifest-channel precedent of the 2026-06-17 ATO-199 ADR**
 (per-backend `tag` instead of a single `tag_name`). **Deliberately NOT
 done (out of scope):** no CUDA-on-Linux turboquant (the fork publishes
 none — Linux Vulkan serves both CPU and GPU); no change to the
 `:1337/v1` proxy contract (it already routes the turboquant + upstream +
 MLX pools); no cron auto-generator for the manifest (hand-maintained,
 same as the upstream ADR); no legacy `jan*` renames. macOS is unchanged.
 **Verified:** `cargo test --lib backend` 33/33 green in
 `tauri-plugin-llamacpp`; `turboquant-manifest.json` valid against
 `turboquant-schema.json` (`ajv --strict=false`) and the node integrity
 check passes (5 backends, tags/assets well-formed, ids unique); the
 `llamacpp-extension` rolldown build is clean (the authoritative compile);
 web-app `tsc -b` + `eslint src/lib/utils.ts` clean; `make -n
 download-llamacpp-backend` parses on both the Windows (PowerShell) and
 Linux (bash+jq) branches. The extension `vitest` run hits a pre-existing
 `ERR_REQUIRE_ESM` env issue (vitest/vite version mismatch in the hoisted
 root `node_modules`) unrelated to this change.
- **Owner:** team.
- **Links:** the 2026-06-17 ADR *Resolve the `llamacpp-upstream` backend
 index from a static `atomic-chat-conf` manifest …* (ATO-199, the
 manifest-channel precedent), the 2026-05-22 ADR *Windows ships only
 `llamacpp-upstream`*, the 2026-05-28 ADR *Linux ships only
 `llamacpp-upstream`*, the 2026-05-19 ADRs *Use
 `AtomicBot-ai/atomic-llama-cpp-turboquant` as the LLM backend* and *Ship
 upstream `ggml-org/llama.cpp` as a second macOS provider*, §4.2 *LLM
 backend*,
 [AtomicBot-ai/atomic-llama-cpp-turboquant releases](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases),
 files:
 [`src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs),
 [`extensions/llamacpp-extension/src/backend.ts`](extensions/llamacpp-extension/src/backend.ts),
 [`extensions/llamacpp-extension/src/index.ts`](extensions/llamacpp-extension/src/index.ts),
 [`package.json`](package.json),
 [`src-tauri/tauri.windows.conf.json`](src-tauri/tauri.windows.conf.json),
 [`src-tauri/tauri.linux.conf.json`](src-tauri/tauri.linux.conf.json),
 [`Makefile`](Makefile),
 [`.github/workflows/release.yml`](.github/workflows/release.yml),
 [`web-app/src/lib/utils.ts`](web-app/src/lib/utils.ts), and
 `atomic-chat-conf` `backends/turboquant-manifest.json` +
 `backends/turboquant-schema.json` + `.github/workflows/validate.yml`.

---
date: 2026-06-16
title: "Port the runtime CUDA-family resolution into the Windows build scripts so `make dev-windows` / `download:bin` stop 404ing on a hardcoded `win-cuda-13.1` minor (ATO-174, build side)"
---

# 2026-06-16 — Port the runtime CUDA-family resolution into the Windows build scripts so `make dev-windows` / `download:bin` stop 404ing on a hardcoded `win-cuda-13.1` minor (ATO-174, build side)

- **Context:** `yarn download:bin` → `make dev-windows` →
 `download-llamacpp-upstream-backend` (Windows GPU-detection branch) failed on a
 user's CUDA-capable host with `[FATAL] No recent release carries asset
 llama-<tag>-bin-win-cuda-13.1-x64.zip`. Root cause is the **build-side twin** of
 [ATO-174](https://linear.app/atomicchat/issue/ATO-174): the same-day 2026-06-15
 ADR *Stop "Find optimal backend" from silently degrading to CPU … de-hardcode
 the Windows CUDA minor to a family id* fixed the **runtime** (TS
 [`backend.ts`](extensions/llamacpp-upstream-extension/src/backend.ts) +
 Rust [`backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs)
 resolve `win-cuda-13-x64` → highest published minor), but the **build scripts**
 still hardcoded the concrete `win-cuda-13.1-x64` / `win-cuda-12.4-x64` asset
 names. ggml-org moved its published Windows CUDA-13 asset from `13.1` → `13.3`,
 so the exact-name lookup in the build scripts matched nothing and aborted. CI
 was **never** affected — the Windows release job bundles a hardcoded
 `BACKEND="win-cpu-x64"` (CPU-only offline fallback; GPU CUDA is resolved at
 runtime in-app), and the macOS/Linux `make download-llamacpp-upstream-backend`
 steps take their own non-CUDA branches — so this was purely a local
 dev/`download:bin` failure.
- **Decision (per the user's "fix it for users *and* CI" ask; build-scripts-only,
 no app/runtime/Rust change — runtime was already fixed):** Mirror the runtime's
 family-resolution into every build-side Windows backend selector. The selector
 now emits a **minor-less family id** (`win-cuda-13-x64` / `win-cuda-12-x64`) and
 a resolver turns it into the **highest concrete minor actually published** in
 the newest release that carries it.
 1. **[`Makefile`](Makefile)** (`download-llamacpp-upstream-backend`, Windows
 branch): driver gate raised `58100` → `58115` (matches the Rust
 `min_cuda13_driver = 581.15`; CUDA-12 stays `55161`), backend set to
 `win-cuda-13-x64` / `win-cuda-12-x64`. A new `jq` branch (gated on
 `^win-cuda-[0-9]+-x64$`) extracts the major, scans the `?per_page=20` release
 list, and for the newest release carrying any `…-bin-win-cuda-<major>.<minor>-x64.zip`
 picks `(minor | max)` → concrete `TAG` + `BACKEND`; non-family ids keep the
 existing exact-name `_resolve_tag`. The resolved concrete `BACKEND`/`TAG` flow
 into the download URL, `backend.txt`/`version.txt`, and the
 `download-llamacpp-cudart-windows.ps1` cudart merge.
 2. **[`scripts/dev-windows.ps1`](scripts/dev-windows.ps1)**: driver gate
 `581` → `581.15`, `$cudaTier` values `131`/`124` → `13`/`12`, backend →
 `win-cuda-{13,12}-x64`. New `Resolve-BackendFromReleases` (family → highest
 published minor, else exact match) and `Test-BackendSatisfiedBy` (does an
 already-installed `win-cuda-13.3-x64` satisfy the selected `win-cuda-13-x64`
 family → skip re-download). The resolved concrete id is what's written to
 `backend.txt` and passed to the cudart merge.
 3. **[`scripts/download-llamacpp-cudart-windows.ps1`](scripts/download-llamacpp-cudart-windows.ps1)**:
 dropped the static `cuda-12.4`/`cuda-13.1` → cudart-archive map. The regex now
 accepts any `^win-cuda-(\d+)\.\d+-x64$`; the cudart archive name is derived as
 `cudart-llama-bin-<backend>.zip` and the marker DLL as `cudart64_<major>.dll`
 — so any future minor works with no edit.
- **Consequences:** Local `make dev-windows` / `yarn download:bin` on a
 CUDA host now resolve to whatever CUDA-13/12 minor ggml-org currently ships
 (verified `13.3` on the live release set) instead of dead-ending on the stale
 `13.1`, and survive future minor bumps. **CI is unchanged** (it already bundled
 `win-cpu-x64`; the GPU path is runtime-resolved in-app), so the
 `release.yml` / `build-windows-release.ps1` files were reviewed and left
 untouched. macOS/Linux build branches untouched. **Verified:** the `jq`
 family-resolution program tested against a fixture (newest release with `13.3` +
 an older `13.1` + cpu/vulkan/12.4 noise) → `b9670 win-cuda-13.3-x64` for major
 13, `…12.4…` for major 12, empty for major 99; the PowerShell
 `Resolve-BackendFromReleases` / `Test-BackendSatisfiedBy` truth table passes
 (family→highest-minor, exact cpu match, null on no-match, `13.3` satisfies
 `13-family` but `12.4`/`vulkan` don't); both `.ps1` files pass the PowerShell
 AST parser; `make -n download-llamacpp-upstream-backend` parses clean. No
 lingering hardcoded CUDA minor remains in any build script (only illustrative
 `13.3` comments).
- **Amendment (same day) — make `dev-windows.ps1`'s release fetch survive GitHub
 rate-limits / outages (degrade, don't abort `make dev`).** After the family fix,
 a user hit `Invoke-RestMethod : API rate limit exceeded` — the **bare,
 un-retried** `Invoke-RestMethod` in `dev-windows.ps1`'s download path (the
 script `make dev-windows` actually runs; the hardened Makefile `_gh_fetch`
 branch is a *different* target) hit GitHub's 60-req/hr unauthenticated limit and
 hard-failed the whole dev run. Added `Invoke-GitHubReleases` (retry/backoff on
 403/429/5xx, mirroring the Makefile `_gh_fetch`; honors `GH_TOKEN`; returns
 `$null` instead of throwing so the caller can degrade) and **reordered the
 download block** so the destructive `Remove-Item` of a differing existing
 backend now happens **only after** a replacement is resolved — a
 rate-limited/failed fetch no longer destroys a working backend. On total fetch
 failure the script degrades to an **already-installed** backend (reuse, warn)
 and only hard-fails when nothing usable is on disk, with an **actionable**
 message pointing at `GH_TOKEN` (raises the limit to 5000 req/hr). Driver-gate
 note: a host on driver `581.08` correctly selects `win-cuda-12-x64` (below the
 NVIDIA-documented `581.15` floor for CUDA 13.1, matching the in-app runtime
 gate) — not a regression. **Verified:** `dev-windows.ps1` passes the PowerShell
 AST parser; `Invoke-GitHubReleases` returns the array on success and `$null`
 (no throw) on failure.
- **Owner:** team.
- **Links:** [ATO-174](https://linear.app/atomicchat/issue/ATO-174), the
 2026-06-15 ADR *Stop "Find optimal backend" from silently degrading to CPU … de-hardcode
 the Windows CUDA minor to a family id (ATO-174)* (runtime side), the
 2026-06-08 ADR *Windows: fix clean-install config persistence (ATO-107),
 de-hardcode the CUDA-13 minor (ATO-105) …*, the 2026-05-22 ADR *Windows ships
 only `llamacpp-upstream`*, the 2026-05-22 ADR *Ship cudart DLLs with every
 Windows CUDA backend*, the 2026-06-05 ADR *Make the Windows release backend
 download asset-aware … (ATO-95, CI)*, files:
 [`Makefile`](Makefile) (`download-llamacpp-upstream-backend` Windows branch),
 [`scripts/dev-windows.ps1`](scripts/dev-windows.ps1)
 (`Resolve-BackendFromReleases`, `Test-BackendSatisfiedBy`),
 [`scripts/download-llamacpp-cudart-windows.ps1`](scripts/download-llamacpp-cudart-windows.ps1),
 runtime counterparts
 [`extensions/llamacpp-upstream-extension/src/backend.ts`](extensions/llamacpp-upstream-extension/src/backend.ts)
 / [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs).

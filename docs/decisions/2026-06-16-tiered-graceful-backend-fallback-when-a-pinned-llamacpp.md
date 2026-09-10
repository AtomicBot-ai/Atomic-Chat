---
date: 2026-06-16
title: "Tiered graceful backend fallback when a pinned `llamacpp-upstream` tag 404s / the ggml-org release stream is unreachable (ATO-178; extends ATO-179)"
---

# 2026-06-16 — Tiered graceful backend fallback when a pinned `llamacpp-upstream` tag 404s / the ggml-org release stream is unreachable (ATO-178; extends ATO-179)

- **Context:** Failure mode 2 of [ATO-176](https://linear.app/atomicchat/issue/ATO-176).
  A model is pinned to a concrete ggml-org tag whose per-platform asset **404s**
  (`Failed to download backend b9616/ubuntu-vulkan-x64: HTTP status 404` — 263
  events; `b9637/ubuntu-vulkan-x64: 404` — 44) or the **release stream is
  unreachable** (`Could not resolve a release for 'win-cuda-13.3-x64' /
  'win-cuda-12.4-x64' / 'win-vulkan-x64' / 'linux-vulkan-x64' … unreachable and
  no version of this backend is installed locally.` — 149/97/70/63). The
  same-day ATO-179 fix already added a **single-tier** load-path fallback
  (`findCompatibleInstalledBackend` → newest installed of the same type) into
  [`ensureBackendReady`](extensions/llamacpp-upstream-extension/src/index.ts),
  which covers the "pinned tag empty but a sibling is installed" case — but it
  does **not** cover ATO-178's core asks: (a) **404 on the pinned tag → fetch
  the nearest available (newer published) tag** of the same family, and (b) a
  last-resort degrade + an actionable error. The automated-triage PR #67 had
  implemented exactly (a)+(b) but on the *pre-ATO-179* signature, so it
  conflicted with `main` and was closed in favour of this extend-on-top-of-179
  change.
- **Decision (per chosen option "extend on main"; extension-only, no Rust/IPC/
  schema change):** Replace the single-tier AC2 block in `ensureBackendReady`
  (load path, `allowFallback=true`) with a new tiered resolver
  `resolveBackendFallback(backend, failedVersion)` returning
  `{ version, backend, persist } | null`, resolving most-preferred first:
  1. **Same-type installed** (`findCompatibleInstalledBackend`, the ATO-179
     mechanism) — instant, offline-safe, preserves the variant. `persist:true`.
  2. **Newest published tag of the same family on ggml-org**
     (`resolveLatestBackendString` → `downloadAndInstallBackend`) — the genuine
     "404 on this tag → pull the nearest available tag" path; adopted only if it
     actually installs. `persist:true` (same variant, newer tag).
  3. **Newest installed backend of any family** (`getLocalInstalledBackends`,
     sorted by build number) — last-resort safety net so the app stays usable
     (e.g. degrade a GPU variant to the bundled CPU build; installed backends
     are host-compatible by construction). **`persist:false`** — a temporary
     degrade must not permanently downgrade a GPU user to CPU, so it is applied
     **in-memory only** (`this.config.version_backend`), letting a later "Find
     optimal backend" / manual pick re-target the right tier once the stream
     recovers. The terminal throw is now **actionable** ("…release stream may be
     unreachable or that release has no build for your platform … Check your
     internet connection (Settings → Proxy) and try again later.") instead of
     the generic "reinstall the app".
- **Consequences:** A 404/unreachable on a pinned tag no longer hard-fails when
  any compatible backend is on disk **or** when a newer same-family release
  ships the asset; only a same-variant tier persists, the CPU degrade stays
  ephemeral. The strict no-fallback path is preserved for explicit
  install/update flows (`updateBackend`, `onSettingUpdate`, `getDevices` still
  pass `allowFallback=false`). Scope: one extension TS file (the AC2 block +
  new `resolveBackendFallback`); ATO-179's AC1 (clear stale dir) / AC3 (startup
  sweep) / `getDevices` fallback / `persistVersionBackend` are untouched. macOS
  turboquant `llamacpp` and MLX unaffected. **Verified:** rolldown build clean
  (`dist/index.js` 220.78 kB, exit 0 — the authoritative compile); vitest 88
  passed / 14 failed — the 14 failures are **pre-existing** (env/network
  `__TAURI_INTERNALS__` in the sandbox, identical to the ATO-179 baseline),
  unchanged by this diff. PR #67 closed as superseded.
- **Owner:** team.
- **Links:** [ATO-178](https://linear.app/atomicchat/issue/ATO-178),
  [ATO-176](https://linear.app/atomicchat/issue/ATO-176),
  [ATO-177](https://linear.app/atomicchat/issue/ATO-177),
  [PR #67](https://github.com/AtomicBot-ai/Atomic-Chat/pull/67) (closed,
  superseded), the same-day ADR *Treat empty/incomplete `llamacpp-upstream`
  backend folders as not-installed … (ATO-179)*, the 2026-06-10 ADR *Fix the two
  real model-load bugs … resolve the `latest/<backend>` sentinel before load
  (ATO-124)*, files:
  [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
  (`ensureBackendReady` AC2 block, `resolveBackendFallback`).

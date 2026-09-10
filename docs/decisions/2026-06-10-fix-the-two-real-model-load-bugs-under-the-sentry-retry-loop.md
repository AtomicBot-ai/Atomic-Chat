---
date: 2026-06-10
title: "Fix the two real model-load bugs under the Sentry retry-loop noise: resolve the `latest/<backend>` sentinel before load (ATO-124) + reactive MTP-disable fallback (ATO-125)"
---

# 2026-06-10 — Fix the two real model-load bugs under the Sentry retry-loop noise: resolve the `latest/<backend>` sentinel before load (ATO-124) + reactive MTP-disable fallback (ATO-125)

- **Context:** First Sentry triage of `atomic-chat-desktop` ([ATO-123](https://linear.app/atomicchat/issue/ATO-123))
 showed ~18k events in ~13h, ~90% a single backoff-less retry-loop, hiding two
 real load bugs. **ATO-124 (Urgent):** `version_backend.includes('/')` was used
 as the "backend resolved" predicate, but the sentinel `latest/<backend>` also
 contains `/` and passed it, so the load path started on an unresolved sentinel
 → `ensureBackendReady('latest')` → `downloadAndInstallBackend` throws on the
 `version === 'latest'` guard (ATO-95) → web-app auto-restarts → tight loop
 (Sentry `ATOMIC-CHAT-DESKTOP-1` win-cpu ~10.4k, `-5` linux-cpu ~6.5k; ~74% of
 90d events). **ATO-125 (Medium):** the else-branch that zeroed `mtp_draft_path`
 left `cfg.mtp = true` for a model with no MTP layers/head (Gemma 4 E4B) →
 `llama-server` aborts `context type MTP requested but model doesn't contain MTP
 layers`.
- **Decision:** Apply both fixes to the `llamacpp-upstream` extension (the
 default/Windows+Linux provider). Crucially, **the ATO-125 preventive crash is
 already fixed in the working tree** by the same-day ATO-122 load-time MTP
 capability gate (`performLoad`, ~3268 — keeps `mtp` only for a Qwen built-in
 MTP id or a resolved Gemma draft, else `cfg.mtp = false`), which is *stronger*
 than ATO-125's optional preventive snippet (that snippet would wrongly disable
 a Qwen built-in MTP model with no draft path). So ATO-125 here is implemented
 only as the **reactive fallback** (variant A), as defense-in-depth, not a
 duplicate preventive guard.
 1. Two pure helpers in
 [`util.ts`](extensions/llamacpp-upstream-extension/src/util.ts):
 `isConcreteVersionBackend(vb)` (BOM/whitespace-stripped; rejects empty /
 `none` / no-slash / `latest/…` sentinel) and `matchesMtpLoadFailure(text)`
 (matches the three MTP-rejection stderr phrasings, case-insensitive,
 apostrophe-optional).
 2. **ATO-124** in [`index.ts`](extensions/llamacpp-upstream-extension/src/index.ts):
 `configureBackends` (~737, apply bundled backend over a sentinel) and `load`
 (~3075, wait for `configureBackends` when not yet concrete) now use
 `isConcreteVersionBackend`; plus a defense-in-depth resolve at the top of
 `performLoad` (before the `version_backend.split('/')`) that turns a leftover
 `latest/<backend>` into a concrete `<tag>/<backend>` via
 `resolveLatestBackendString` → `newestInstalledOfFamily`, **persisting** it to
 `this.config` so subsequent loads short-circuit (and warns when both resolvers
 return null — the accepted residual offline gap).
 3. **ATO-125** in `index.ts`: a one-shot retry inside `performLoad`'s `catch`
 (after the mmproj text-only retry, before the final `logger.error`) — if
 `cfg.mtp` and the error matches `matchesMtpLoadFailure`, retry once with
 `cfg.mtp=false`/`mtp_draft_path=''`.
- **Consequences:** The sentinel can no longer reach the download guard, killing
 the dominant retry-loop at the source for every load entry point; MTP loads
 degrade gracefully even if a future model slips past the ATO-122 gate. Scope:
 web-app extension only (one Rust-free TS module + the extension entry); macOS
 turboquant `llamacpp` and MLX unaffected. **Verified:** `ReadLints` clean on
 all three files; `util.test.ts` 38/38 (21 new — 13 `isConcreteVersionBackend`
 + 8 `matchesMtpLoadFailure`); rolldown build clean (`dist/index.js` 205 kB).
 The 14 other failures in the extension suite are **pre-existing** — proven by a
 stash-baseline run on HEAD showing the identical `index.test.ts`(9) /
 `backend.test.ts`(4) / `autoIncreaseCtx.test.ts`(1) failures (env/network in
 the sandbox), unchanged by this diff (66→87 passing = exactly +21). **Not
 done:** ATO-126/127/128 (Sentry hygiene: backoff+dedup, noise downgrade,
 `setUser`) are separate hygiene tickets; changes not committed/pushed (await
 review).
- **Owner:** team.
- **Links:** [ATO-123](https://linear.app/atomicchat/issue/ATO-123),
 [ATO-124](https://linear.app/atomicchat/issue/ATO-124),
 [ATO-125](https://linear.app/atomicchat/issue/ATO-125),
 [ATO-95](https://linear.app/atomicchat/issue/ATO-95), the 2026-06-10 ADR *Gate
 the global `mtp` flag …* (ATO-122) and the 2026-06-05 ADRs *Resolve the
 `latest/<backend>` sentinel …* / *Make the Windows release backend download
 asset-aware …*, files:
 [`util.ts`](extensions/llamacpp-upstream-extension/src/util.ts),
 [`index.ts`](extensions/llamacpp-upstream-extension/src/index.ts),
 [`util.test.ts`](extensions/llamacpp-upstream-extension/src/util.test.ts).

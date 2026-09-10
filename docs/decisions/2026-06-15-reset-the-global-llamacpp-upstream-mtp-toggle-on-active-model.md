---
date: 2026-06-15
title: "Reset the global `llamacpp-upstream` MTP toggle on active-model change so it can't stay \"on\" for a non-MTP model (ATO-54)"
---

# 2026-06-15 — Reset the global `llamacpp-upstream` MTP toggle on active-model change so it can't stay "on" for a non-MTP model (ATO-54)

- **Context:** The `llamacpp-upstream` **MTP** toggle is a **provider-global**
 boolean (`mtp` in the extension settings, surfaced as a Switch in
 [`$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx)).
 Support was validated **only on manual toggle-on** (`handleToggleLlamacppMtp`),
 never when the active model changed. Two reported scenarios
 ([ATO-54](https://linear.app/atomicchat/issue/ATO-54)): (1) MTP "auto-on" /
 stale global flag applied to a non-MTP model (`Qwen3.6-…-APEX`) → opaque load
 failure; (2) toggle stays on when switching from an MTP-capable model A to a
 non-capable model B → same failure. The 2026-06-10 load-time capability gate
 (ATO-122, `performLoad`) already **prevents the crash** (silently drops
 `cfg.mtp` for non-capable targets), but the **UI Switch stayed visually "on"**,
 a confusing mismatch — exactly ATO-54's remaining ask.
- **Decision:** Per the user's chosen option (**MLX parity, capability-aware**;
 the alternative of true per-model `model.yml` persistence was explicitly
 rejected as the larger change ADR 2026-06-10 had already deferred). Added a
 brother-effect to the existing MLX reset-on-model-change effect, scoped to
 `provider === 'llamacpp-upstream'`: a `useMemo` tracks the active upstream
 model id (`activeModels ∩ provider.models`), and a `useEffect` (skipping first
 mount + no-op changes, mirroring the MLX one) reconciles on change — when
 `mtp` is on and the new active model is **not** MTP-capable (same heuristic as
 the toggle handler / load gate: Qwen built-in MTP = id contains `"mtp"`, or
 `engine.checkGemmaMtpSupport(id)` for Gemma 4 31B/26B-A4B), it writes
 `mtp = false` via `updateSettings` + `updateProvider`. MTP-capable targets keep
 the value. The capability probe is async (Gemma check) and guarded by a
 `cancelled` flag for unmount safety.
- **Consequences:** Switching to a non-MTP model now flips the Switch off and
 persists `mtp = false`, so the UI reflects reality and no stale spec-decode arg
 is carried (the ATO-122 load gate remains as defense-in-depth). **Trade-off
 (accepted, = MLX parity):** the flag is still **provider-global**, not true
 per-model memory — re-selecting a previously-MTP model A does **not** restore
 its toggle (it defaults off). **First-mount is intentionally skipped** (MLX
 parity), so opening Settings with an already-active non-MTP model + a stale
 `mtp` flag won't auto-reset until the next model change; correctness is
 unaffected because the load gate still drops MTP. Scope: web-app only (1 effect
 + 1 memo + 1 ref in `$providerName.tsx`); no Rust, IPC, `model.yml`/settings
 schema, or extension change. macOS turboquant `llamacpp` (no MTP toggle) and
 MLX (already has its own reset) are untouched. **Verified:** `tsc -b` clean
 (exit 0); `eslint` clean ("No issues found") on the touched file.
- **Owner:** team.
- **Links:** [ATO-54](https://linear.app/atomicchat/issue/ATO-54),
 [ATO-122](https://linear.app/atomicchat/issue/ATO-122), the 2026-06-10 ADR
 *Gate the global `mtp` flag on per-model capability at load time …*, files:
 [`web-app/src/routes/settings/providers/$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx)
 (`activeLlamacppUpstreamModelId` memo + reset effect, mirroring the MLX
 `activeMlxModelId` reset).

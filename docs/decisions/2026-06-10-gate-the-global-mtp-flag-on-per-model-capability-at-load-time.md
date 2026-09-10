---
date: 2026-06-10
title: "Gate the global `mtp` flag on per-model capability at load time so non-MTP models can't be bricked by a stale toggle (ATO-122)"
---

# 2026-06-10 — Gate the global `mtp` flag on per-model capability at load time so non-MTP models can't be bricked by a stale toggle (ATO-122)

- **Context:** The `llamacpp-upstream` **MTP (multi-token prediction)** toggle is
 a **provider-global** setting (`mtp` in the extension's localStorage → loaded
 into `this.config`), not bound to a model and never reset on model switch
 (unlike MLX, which resets `mtp_enabled`/`dflash_enabled`/`eagle3_enabled` when
 the active MLX model changes). So enabling MTP on a capable target (e.g. a
 Qwen built-in-MTP GGUF) and then loading a model **without** MTP layers (e.g.
 the **Recommended** `gemma-4-12b-it-IQ4_XS`) left `cfg.mtp === true`, and the
 Rust arg builder [`add_mtp_args`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs)
 gated **only** on `config.mtp` + build number — never on whether the GGUF is
 MTP-capable. With an empty `mtp_draft_path` it emitted the Qwen-style
 `--spec-type draft-mtp` (the model as its own draft context), and
 `llama-server` (upstream `b9562`) aborted the whole load:
 `context type MTP requested but model doesn't contain MTP layers` →
 `failed to create MTP context` → exit. The user saw a generic
 "Failed to load the model" and blamed themselves (Discord `ez5554`, Mac Studio
 M4 Max, v1.1.104). Repro: enable MTP on Qwen → switch to Gemma-4-12B → Start →
 crash. The same Gemma loads fine the moment MTP is toggled off. The crash is a
 **first-run hazard** because Gemma-4-12B is Recommended.
- **Decision:** Implement the ticket's **graceful-fallback** option (option 3 of
 "any of"), at the lowest common load layer rather than only the UI toggle. A
 new capability gate in
 [`performLoad`](extensions/llamacpp-upstream-extension/src/index.ts) (right
 after Gemma draft-head resolution, before building Rust args): when `cfg.mtp`
 is on, keep it on **only** if the target genuinely supports MTP — either a
 **Qwen-style built-in MTP** GGUF (`modelId.toLowerCase().includes('mtp')`,
 mirroring the UI's own heuristic in
 [`$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx))
 **or** a **Gemma 4** target whose separate draft head resolved to a non-empty
 `cfg.mtp_draft_path` above. Otherwise set `cfg.mtp = false` and `logger.warn`,
 so the model loads cleanly without MTP. The gate sits in TS (not Rust) because
 Rust cannot distinguish a Qwen built-in-MTP model from a plain GGUF — both
 carry no draft path; only the extension knows the model id / Gemma registry.
- **Consequences:**
 - **The reported crash is gone for every load entry point** (chat model
 switch, onboarding, API), not just the settings toggle. The Recommended
 Gemma 4 model can no longer be bricked by a stale global MTP flag.
 - **Emergent per-model behaviour without per-model state.** The provider
 toggle stays in localStorage (still globally "on"); MTP now silently
 *follows capability* — active for Qwen/Gemma MTP targets, dropped for
 everything else, re-activating automatically when an MTP-capable model is
 loaded again. This satisfies the spirit of option 1 (per-model) with a
 one-block change and no schema/UI migration.
 - **Deliberately did NOT** (a) move `mtp` into `model.yml` / `model.settings`
 (larger UI + persistence change, unnecessary given the gate), or (b) add an
 upstream model-change reset effect mirroring MLX (the load-time gate is
 strictly more robust — it also covers loads triggered outside the settings
 screen). The UI capability check in `handleToggleLlamacppMtp` (which only
 runs when a model is already loaded) is left as-is; the gate backstops it.
 - **Caveat:** the toggle UI can still read "on" while a non-MTP model is
 loaded — accepted per the ticket (graceful fallback is an explicitly
 acceptable resolution). Related to [ATO-121](https://linear.app/atomicchat/issue/ATO-121)
 (surface a clear engine-incompatibility error), which is a separate ticket.
 - Scope: one TS block in the upstream extension; no Rust, IPC, on-disk layout,
 or settings-schema change. macOS turboquant `llamacpp` provider has no MTP
 toggle and is unaffected; MLX is unaffected. Lint-clean on the edited file.
- **Owner:** team.
- **Links:** [ATO-122](https://linear.app/atomicchat/issue/ATO-122),
 [ATO-121](https://linear.app/atomicchat/issue/ATO-121), §4.2 *LLM backend*,
 the 2026-06-08 ADR *Add Gemma 4 MTP speculative decoding to `llamacpp-upstream`
 via a separate draft head …*, files:
 [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
 (`performLoad` MTP capability gate),
 [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs)
 (`add_mtp_args`),
 [`web-app/src/routes/settings/providers/$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx)
 (`handleToggleLlamacppMtp`).

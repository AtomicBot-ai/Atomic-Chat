---
date: 2026-06-11
title: "Surface a user-selectable K/V cache type dropdown on the upstream `llamacpp-upstream` provider (standard types only)"
---

# 2026-06-11 — Surface a user-selectable K/V cache type dropdown on the upstream `llamacpp-upstream` provider (standard types only)

- **Context:** The TurboQuant `llamacpp` provider exposes **KV Cache K/V Type**
 dropdowns (`cache_type_k` / `cache_type_v`,
 [`extensions/llamacpp-extension/settings.json`](extensions/llamacpp-extension/settings.json)
 lines 251–290) defaulting to the fork-only `turbo3`, plus the standard
 ggml-org types. The upstream `llamacpp-upstream` provider had **no** such UI:
 the whole end-to-end plumbing already existed — guest-js
 (`tauri-plugin-llamacpp-upstream/guest-js/types.ts` +
 `normalizeLlamacppConfig`) carries `cache_type_k/v`, and the Rust arg builder
 ([`args.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs)
 ~514–532) already emits `--cache-type-k` (skipped when `f16`) and
 `--cache-type-v` (skipped when `f16`/`f32` **or** when `flash_attn === "off"`),
 with `sanitize_cache_type` falling non-turboquant builds back to `q8_0`. The
 **extension** deliberately hid it: `clearLegacyKvCacheSettings()` (migration
 v4, the 2026-06-04-era "vanilla `llama-server` performs best with its own
 `f16` default" decision) pruned the two keys from the settings list and
 cleared the in-memory config so `args.rs` skipped the flags entirely.
- **Decision:** Re-surface the dropdowns on the upstream provider with **only
 the K/V quant types vanilla ggml-org/llama.cpp supports** — no `turbo*`.
 1. **`settings.json`**
 ([`extensions/llamacpp-upstream-extension/settings.json`](extensions/llamacpp-upstream-extension/settings.json)):
 added `cache_type_k` + `cache_type_v` dropdowns after `mlock`, **default
 `f16`** (llama.cpp's native default → `args.rs` emits nothing, preserving
 prior behaviour for anyone who leaves it untouched), options =
 `f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1` (the
 `STANDARD_CACHE_TYPES` allowlist, **no `turbo3`**). `cache_type_v`'s
 description notes quantized V requires Flash Attention enabled (Auto/On).
 2. **Migrations**
 ([`index.ts`](extensions/llamacpp-upstream-extension/src/index.ts) `onLoad`):
 **removed the `await this.clearLegacyKvCacheSettings()` call** (it would
 strip the freshly-added entries for fresh installs and never re-add them)
 **and the `await this.migrateKvCacheDefaults()` call** (it would flip the new
 `f16` default to `q8_0` for fresh installs). Both methods are left defined
 but uncalled — consistent with the already-dead `migrateKvCacheToTurbo3` —
 so the existing isolated unit tests for `migrateKvCacheDefaults`
 (`src/test/index.test.ts`) still pass unchanged. v3 (`migrateFitDefault`)
 is untouched.
- **Consequences:** Upstream users can now pick a quantized K/V cache type from
 the provider settings to shrink the KV cache (e.g. `q8_0`/`q4_0`), with V
 quantization gated behind Flash Attention exactly as `args.rs` enforces.
 Default stays `f16` (no behavioural change unless the user opts in). **This
 reverses the upstream-specific clause of the earlier "clear KV overrides →
 native `f16`" migration** — the goal is the same native `f16` default, now via
 an explicit, user-overridable dropdown rather than a hidden cleared setting.
 Existing users who already ran v4 (`llamacpp_upstream_kv_cache_cleared_v1`
 set) get the new dropdown automatically once `registerSettings` re-merges the
 keys on the next load. **Scope:** extension only (1 settings file + 2 removed
 call sites + comment) — **no Rust, IPC, guest-js, on-disk, or web-app TSX
 change** (the generic `DynamicControllerSetting` renders the dropdown purely
 from `settings.json`). **Verified:** `settings.json` parses, both entries
 present with `f16` default + standard-only options; `ReadLints` clean on both
 edited files; the `migrateKvCacheDefaults` method (and its tests) is
 byte-unchanged. `tsc`/`rolldown`/`vitest` standalone runs in the sandbox
 resolve to the root workspace config (pre-existing, unrelated `@janhq/web-app`
 `interface.test.tsx` failures) and are not authoritative for these scoped
 edits. **Caveat:** the extension must be rebuilt (`build:extensions`) so the
 new `settings.json` is embedded into the compile-time `SETTINGS` constant.
- **Owner:** team.
- **Links:** §4.2 *LLM backend*, the 2026-06-04 ADR *Recover from unsupported
 multimodal projector …* and the 2026-06-08 ADR *Add Gemma 4 MTP speculative
 decoding to `llamacpp-upstream` …* (KV-quant + MTP warning), files:
 [`extensions/llamacpp-upstream-extension/settings.json`](extensions/llamacpp-upstream-extension/settings.json),
 [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
 (`onLoad` migration block),
 [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs)
 (`--cache-type-k/-v`, `sanitize_cache_type`).

---
date: 2026-06-03
title: "Expand the MLX DFlash draft registry to the full z-lab collection (incl. Gemma 4) and fix the broken sharded Kimi-K2.5 entry"
---

# 2026-06-03 — Expand the MLX DFlash draft registry to the full z-lab collection (incl. Gemma 4) and fix the broken sharded Kimi-K2.5 entry

- **Context:** The DFlash auto-setup registry
  (`extensions/mlx-extension/src/dflashRegistry.ts`) carried 14 of the 20
  drafts published in the curated
  [z-lab/dflash](https://huggingface.co/collections/z-lab/dflash) collection.
  Six were missing — including the two most-downloaded heads in the whole
  collection (`Qwen3.6-27B-DFlash` ~80k, `gemma-4-31B-it-DFlash` ~37k). A live
  HF-API check of every new repo also revealed that **two Kimi drafts ship
  sharded safetensors** (`Kimi-K2.5-DFlash` = 2 shards + index, `Kimi-K2.6-DFlash`
  = 3 shards + index), not a single `model.safetensors`. The pre-existing
  `kimi-k2.5` entry used the default single-file `required` set, so its
  auto-download was **silently broken** — `ensureDraftDownloaded` would 404 on
  the non-existent `model.safetensors` (a hard error for a `required` file) and
  never fetch the shards.
- **Decision:** Add all six missing drafts and repair the sharded set.
  - New keys (normalized via `normalizeBaseId`, verified against EAGLE-3's
    existing gemma keys): `qwen3.6-27b`, `gemma-4-31b`, `gemma-4-26b-a4b`,
    `kimi-k2.6`, `minimax-m2.5`, `minimax-m2.7`.
  - **Gemma 4 gains a third speculative path.** Gemma 4 targets were previously
    served only by MTP (`*-assistant`) and EAGLE-3 (`RedHatAI/*-speculator.eagle3`).
    They now also resolve a DFlash draft (`z-lab/gemma-4-{31B,26B-A4B}-it-DFlash`),
    keyed `gemma-4-31b` / `gemma-4-26b-a4b` to mirror `eagle3Registry.ts`
    (the trailing `-it` is stripped by `TRAIL_HINT_RE`). The three families stay
    mutually exclusive via the existing UI mutex in
    `web-app/src/routes/settings/providers/$providerName.tsx`; the
    `performLoad` precedence (`mtp > eagle3 > dflash`) is unchanged.
  - **Sharded manifest helper.** New `shardedRequired(total)` generates
    `config.json` + `model.safetensors.index.json` + N
    `model-XXXXX-of-YYYYY.safetensors` files. `kimi-k2.5` now uses
    `shardedRequired(2)` (fixing the latent download bug) and `kimi-k2.6` uses
    `shardedRequired(3)`. The other five new repos ship a single
    `model.safetensors` (verified) and keep `DEFAULT_REQUIRED`.
- **Consequences:**
  - DFlash auto-setup now covers the entire z-lab collection (20/20). The two
    highest-traffic drafts and the Gemma 4 family are reachable; Kimi drafts
    actually download instead of erroring. All six repo file sets were confirmed
    against the live HF API (no fabricated filenames).
  - **Product caveat (not addressed here):** a DFlash draft is only useful when
    the matching base MLX model exists and runs locally. MiniMax / Kimi are
    large MoE targets; their entries are present for completeness but their
    practical reach depends on the user having a runnable MLX build of the base
    model. No gating was added — parity with the rest of the registry.
  - Pure data + one local helper; no network calls added to the resolution
    path, no Rust/contract changes. No registry unit tests exist yet.
- **Amendment (same day) — turn the "DFlash unavailable" dialog into an
  inline quant-picker + download/start surface, and close the normalization
  gaps it exposed.** `DflashUnsupportedDialog` now renders every supported base
  model as a Hub-style row (brand `ModelLogo` + name + a quantization
  `<select>` + the shared `MlxModelDownloadAction`). The quant picker is
  populated from the **clean precision builds that actually exist** on
  `mlx-community` (verified against the live HF API — bf16 / mxfp8 / 8/6/5/4/3
  bit / MXFP4 variants per model), ordered highest-first so the default is the
  largest build (bf16 where published).   Each row downloads in place via the shared
  `MlxModelDownloadAction` (progress/cancel) and flips to its own **"New chat"
  (start)** button the moment a matching build is already on disk — matched
  **fuzzily by base prefix + quant tokens** (`localIdMatches`), not by exact
  repo id, so an alternate packaging the user already has (e.g.
  `Qwen3.5-4B-MLX-4bit` when we offer `Qwen3.5-4B-4bit`) is recognized and
  started directly — no navigation to the Hub. The **Start** action launches
  the local build **with its DFlash draft already attached** and stays put (no
  new chat): a new parent handler `handleStartWithDflash` selects the model,
  `enableDflash` downloads/attaches the paired draft (writing engine config
  when no session exists yet, reloading in place if one does), then the
  idempotent `startModel` performs a single draft-carrying load. A
  `startedWithDflashRef` guard in the MLX flag-reset effect stops it from
  wiping `dflash_enabled` when that session becomes active, so the provider
  toggle correctly reflects the running draft. Verifying the repos surfaced gaps where ids did **not**
  normalize back to a registry key (so a draft would never pair): `gpt-oss-*`
  ships only `MXFP4-*` quants, `Kimi-K2.6` only `mxfp8`, and the only published
  `Qwen3-Coder-30B-A3B` MLX repos carry an `-Instruct` infix. Fixes: added
  `mxfp4` / `mxfp8` to `QUANT_SUFFIX_RE` (legitimate quant suffixes, stripped
  only at end → no false positives) and a `qwen3-coder-30b-a3b-instruct` alias
  key. All 107 offered quant repos now normalize to a `STATIC_DRAFT_MAP` key
  (verified by harness). The model→quant list is mirrored in web-app
  (`DflashUnsupportedDialog.tsx`) because web-app can't import the extension
  bundle; it MUST be kept in sync with the registry. New i18n key
  `settings:dflashSupportedListTitle` (EN + RU); the per-row action label comes
  from the shared `MlxModelDownloadAction` (`hub:download` / `hub:newChat`).
- **Owner:** team.
- **Links:** §4.1 *MLX backend*, the 2026-06-02 v0.6.0 sync ADR (EAGLE-3 / MTP
  drafter families), [z-lab/dflash](https://huggingface.co/collections/z-lab/dflash),
  files: [`extensions/mlx-extension/src/dflashRegistry.ts`](extensions/mlx-extension/src/dflashRegistry.ts),
  [`extensions/mlx-extension/src/eagle3Registry.ts`](extensions/mlx-extension/src/eagle3Registry.ts)
  (key convention reference),
  [`web-app/src/containers/dialogs/DflashUnsupportedDialog.tsx`](web-app/src/containers/dialogs/DflashUnsupportedDialog.tsx).

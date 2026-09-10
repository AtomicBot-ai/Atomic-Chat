---
date: 2026-06-08
title: "Hide base (non-`-it`) Gemma 4 MLX models from Hub + recommend the `-it` variants (ATO-88 head 1, fourth follow-up)"
---

# 2026-06-08 — Hide base (non-`-it`) Gemma 4 MLX models from Hub + recommend the `-it` variants (ATO-88 head 1, fourth follow-up)

- **Context:** After the `<|turn>` template + `<turn|>` stop fix (ADR below),
  `mlx-community/gemma-4-12B-4bit` *still* produced garbage on the sidecar
  (`0a82347`) — stray MathML, wrong-script glyphs, fabricated dialogue. Root
  cause is **not a code bug**: that repo's model card declares
  `base_model: google/gemma-4-12B` — the **base (pretrain) model**, not the
  instruction-tuned `…-it`. Base Gemma has **no chat template by design** and
  only does raw text continuation, so it falls out of distribution in chat. The
  earlier server-side template/suppress fixes only masked symptoms; nothing in
  the engine can make a base model behave as an assistant. Confirmed: the user's
  `-it` builds (`gemma-4-e2b-it-4bit`, `gemma-4-e4b-it-4bit`) work; only the base
  `gemma-4-12B-4bit` fails. Sweeping the upstream `Blaizzy/mlx-vlm` delta (fork
  is 69 commits behind, v0.6.2) found no fix for this — `cef92e2` (#1301) targets
  `num_kv_shared_layers > 0` QAT loads (the 12B has `0`), `a4ddde9` is image/video
  drop, the rest docs. Worse, **`atomic-chat-conf/models/recommended.json` itself
  recommended the base e2b/e4b** (`mlx-community/gemma-4-e2b-4bit` /
  `…-e4b-4bit`), and the recommended block resolves `model_name` verbatim
  (`useResolvedRecommendedModels`), bypassing any Hub catalog filter.
- **Decision:** Make base Gemma 4 MLX models unreachable in the UI; recommend the
  `-it` variants. No backend/sidecar change.
  1. **Data fix (`atomic-chat-conf/models/recommended.json`).**
     `gemma-4-e2b-4bit` → `gemma-4-e2b-it-4bit`, `gemma-4-e4b-4bit` →
     `gemma-4-e4b-it-4bit` (both verified live, HTTP 200); bumped `updated_at`.
     The web-app offline constants (`RECOMMENDED_MODEL_FALLBACKS`,
     `BASELINE_MODEL_CATALOG`) already used `-it` — untouched.
  2. **Hub filter (`web-app/src/routes/hub/index.tsx`).** New predicate
     `isUnsupportedBaseGemmaMlx(model)` (mirrors the existing `isJanCatalogModel`
     style): hides a model when it is MLX (`is_mlx` / `library_name==='mlx'`) AND
     its repo basename matches `gemma[-_]?4` AND it is **not** `-it`
     (`/(^|[-_])it([-_]|$)/`, so `4bit`'s "it" is not a false positive) AND not a
     drafter artifact (`assistant`/`eagle3`/`speculator`/`dflash`/`-mtp`). Applied
     at the two aggregation chokepoints: the curated-catalog/​exact-repo filter
     (`filteredModels`, alongside `!isJanCatalogModel`) and the long-tail HF
     fallback tail (`virtualListModels`).
- **Consequences:**
  - Scoped to **MLX + Gemma 4** (the reported failure). GGUF base Gemma stays
    visible (different surface, not reported); Gemma 3 base is out of scope.
    Instruction-tuned `-it`, plus the MTP/EAGLE/DFlash drafter repos, stay
    browsable/usable. Verified with a 14-case truth table (base hidden incl.
    `google/gemma-4-12B`; every `-it`/drafter/non-MLX/non-Gemma kept); `ReadLints`
    clean on the edited TSX; `recommended.json` valid JSON.
  - The `recommended.json` change ships independently of an app release (12-hour
    cron / dispatch in `atomic-chat-model-catalog`'s sibling flow); the Hub filter
    ships with the next web-app build. Neither requires a sidecar rebuild.
  - The prior server-side Gemma fixes (template/suppress/stop) remain correct and
    useful for legitimately template-less `-it` MLX conversions; they are not
    reverted.
- **Owner:** team.
- **Links:** [ATO-88](https://linear.app/atomicchat/issue/ATO-88), §4.1 *MLX
  backend*, the three 2026-06-08 ADRs below, files:
  [`atomic-chat-conf/models/recommended.json`](https://github.com/AtomicBot-ai/atomic-chat-conf),
  `web-app/src/routes/hub/index.tsx` (`isUnsupportedBaseGemmaMlx`,
  `filteredModels`, `virtualListModels`).

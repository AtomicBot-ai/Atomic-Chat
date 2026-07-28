---
date: 2026-06-02
title: "Sync `AtomicBot-ai/mlx-vlm` fork to upstream v0.6.0 and surface a third speculative drafter family (EAGLE-3) + Qwen / DeepSeek-V4 MTP"
---

# 2026-06-02 — Sync `AtomicBot-ai/mlx-vlm` fork to upstream v0.6.0 and surface a third speculative drafter family (EAGLE-3) + Qwen / DeepSeek-V4 MTP

- **Context:** The MLX backend fork (`AtomicBot-ai/mlx-vlm`) was **+8 / -105**
  vs `Blaizzy/mlx-vlm` `upstream/main` (= **v0.6.0 + 1 commit**). The headline
  wins in v0.6.0 are all engine-layer: the new drafter auto-detect path
  (upstream #1125), a third speculative family (`eagle3`), spec-decode
  sampling fixes (#1188/#1210/#1259), spec-compliant streaming usage/timings
  (#1216), and `chat_template_kwargs` support (#1130). The crux of the merge
  was upstream PR #1203, which **deleted the 3778-line monolith
  `mlx_vlm/server.py`** and split it into a package `mlx_vlm/server/`
  (`app.py`, `cli.py`, `openai.py`, `anthropic.py`, `generation.py`,
  `runtime.py`, `responses_state.py`, `schemas.py`, `__main__.py`,
  `__init__.py`). Our 8 commits lived almost entirely in `server.py`, so the
  merge produced a **modify/delete conflict** that had to be hand-ported into
  the new modules. Our Rust facade (`src-tauri/src/core/server/proxy.rs`)
  owns the public `/v1` contract (incl. its own Anthropic `/v1/messages`
  transform), so v0.6.0's value to us is the engine, not the new server
  protocol surface.
- **Decision:** Merge `upstream/main` into the fork and re-port only the
  fork-specific behaviour that upstream still doesn't cover; then extend the
  downstream MLX extension/UI from a 2-family to a 3-family drafter system.

  **Fork sync (`AtomicBot-ai/mlx-vlm`):**
  - **Kept / re-ported into `mlx_vlm/server/`:**
    - `MLX_VLM_SINGLE_MODEL` single-model guard → re-ported into
      `server/app.py::get_cached_model` (the desktop sidecar pins one model
      and must ignore arbitrary `model` labels in incoming request bodies,
      else it 401s trying to fetch a non-existent HF repo).
    - EOS aggregation (`_collect_stop_tokens` / `_coerce_eos_to_set`) →
      re-ported into `server/generation.py`. Upstream still doesn't robustly
      union `eos_token_id` across `config.json` / `text_config` /
      `generation_config.json` / tokenizer for VLM/omni configs.
    - `chat_template_kwargs` nesting → re-ported into `server/app.py`
      `_build_gen_args` (kept as a thin precedence shim over the now-native
      upstream fields, so `enable_thinking` / `thinking_budget` keep flowing).
    - `in_thinking` prompt-seed → re-ported into `server/openai.py` streaming
      path (many chat templates inject the opening `<think>` /
      `<|channel>thought` marker into the *prompt*, so without seeding the
      reasoning/content split the whole CoT leaks into `delta.content`).
  - **Dropped (superseded by upstream):** the `top_p_sampling` arbitrary-batch
    patch (#docstring already documents `[B,T,vocab]`), the lossless
    spec-decode target-sampling patch (#1188/#1210/#1259), and the
    fork's `_make_sampler(temp=0)` spec-decode override (upstream's verify
    path is fixed). The bespoke final-SSE-chunk TPS/usage frame was dropped in
    favour of upstream's spec-compliant `stream_options.include_usage` →
    `GenerationTimings` (see the downstream `includeUsage` fix below).
  - **Fork infra preserved:** `_entry_server.py` (`from mlx_vlm.server import
    main` resolves against the new `__init__.py`), the CI workflows
    (`build-mlxvlm-macos.yml` + the two `*.disabled`), and `uv.lock`
    regenerated keeping `llguidance` + `mlx-audio` (now also in upstream's
    `requirements.txt`).

  **Downstream (`Atomic-Chat`):**
  - **TPS regression fix:** `web-app/src/lib/model-factory.ts::createMlxModel`
    now sets `includeUsage: true`. v0.6.0 (#1216) made the streaming
    `usage`/`timings` frame opt-in via `stream_options.include_usage`; the
    pre-v0.6.0 fork emitted it unconditionally, so the UI used to get
    `timings.predicted_per_second` for free. Without the flag the decode-rate
    readout would silently fall back to a wall-clock estimate.
  - **Third drafter family surfaced (EAGLE-3) + new MTP pairings:**
    - New `extensions/mlx-extension/src/eagle3Registry.ts` mapping the two
      Gemma 4 targets → `RedHatAI/gemma-4-{31B,26B-A4B}-it-speculator.eagle3`
      (mirrors `dflashRegistry.ts`; E2B/E4B have no EAGLE-3 head and keep
      using the MTP assistant).
    - `extensions/mlx-extension/src/mtpRegistry.ts` extended with the
      split-out, separately-published `mlx-community/*-MTP-bf16` heads:
      Qwen `3.5-4B`, `3.5-9B`, `3.6-27B`, `3.6-35B-A3B` (`model_type:
      qwen3_5_mtp`) and `DeepSeek-V4-Flash` (`model_type: deepseek_v4_mtp`).
      All three families share `--draft-kind` values, so they all resolve via
      the same `mtp` kind; the reverse-lookup was generalised from
      `-assistant` to also match `-MTP-` ids. Every repo id was verified
      against the live HF API — no fabricated repos.
    - `extensions/mlx-extension/src/index.ts`: the 2-way (`mtp|dflash`)
      `performLoad` resolver became a 3-way (`mtp|eagle3|dflash`, fixed
      precedence `mtp > eagle3 > dflash`); `ensureDraftDownloaded`'s `kind`
      union, the `onSettingUpdate` block-size debounce map, and the
      enable/disable mutex now cover `eagle3`. New `enableEagle3` /
      `disableEagle3` / `checkEagle3Support` mirror the MTP trio. EAGLE-3's
      block size defaults to `0` = "use the speculator's built-in depth"
      (the Rust shim only emits `--draft-block-size` when > 0).
    - `extensions/mlx-extension/settings.json`: added `eagle3_enabled` +
      `eagle3_block_size` toggles. UI: new
      `web-app/src/containers/dialogs/Eagle3UnsupportedDialog.tsx`, an
      EAGLE-3 Switch + handler in
      `web-app/src/routes/settings/providers/$providerName.tsx` (mutually
      exclusive with DFlash/MTP, MLX-provider-gated), and `eagle3*` i18n keys
      in `web-app/src/locales/en/settings.json`.
  - **Rust contract:** `tauri-plugin-mlx::MlxConfig.draft_kind` was already a
    verbatim passthrough to `--draft-kind`; only its doc comments were updated
    to enumerate the third family. No behavioural Rust change was needed.
- **Consequences:**
  - macOS users get auto-detected drafter loading, the upstream spec-decode
    correctness fixes, and a third drafter family in the MLX provider
    settings. Coverage now spans DFlash + MTP (Gemma 4 / Qwen / DeepSeek-V4) +
    EAGLE-3 (Gemma 4), each guarded behind a static, network-free registry
    with local-first resolution and direct `/resolve/main/<file>` downloads.
  - The public `localhost:1337/v1` contract is unchanged — the Rust proxy
    still owns it; `/chat/completions` and `/v1/messages` behave as before.
  - The three drafter families share one on-disk cache
    (`mlx/draft-models/<repo>/`); collisions are impossible because the repo
    prefixes are disjoint (`z-lab/…`, `mlx-community/…`, `RedHatAI/…`).
  - **Not done:** TurboQuant-for-MLX weight quant and any non-macOS MLX path
    remain out of scope (MLX is Apple-Silicon-only). The fork is **not yet
    committed** — changes await explicit approval per the plan's verification
    ritual.
- **Owner:** team.
- **Links:** [AtomicBot-ai/mlx-vlm](https://github.com/AtomicBot-ai/mlx-vlm),
  [Blaizzy/mlx-vlm](https://github.com/Blaizzy/mlx-vlm) (v0.6.0, PRs #1125,
  #1130, #1188, #1203, #1210, #1216, #1259), §4.1 *MLX backend*,
  files: `extensions/mlx-extension/src/eagle3Registry.ts`,
  `extensions/mlx-extension/src/mtpRegistry.ts`,
  `extensions/mlx-extension/src/index.ts`,
  `extensions/mlx-extension/settings.json`,
  `web-app/src/containers/dialogs/Eagle3UnsupportedDialog.tsx`,
  `web-app/src/routes/settings/providers/$providerName.tsx`,
  `web-app/src/lib/model-factory.ts`,
  `src-tauri/plugins/tauri-plugin-mlx/src/commands.rs`.

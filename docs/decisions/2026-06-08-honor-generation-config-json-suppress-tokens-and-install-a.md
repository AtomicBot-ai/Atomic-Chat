---
date: 2026-06-08
title: "Honor `generation_config.json::suppress_tokens` and install a Gemma chat-template fallback in the `mlx-vlm` server (ATO-88 head 1, second follow-up)"
---

# 2026-06-08 — Honor `generation_config.json::suppress_tokens` and install a Gemma chat-template fallback in the `mlx-vlm` server (ATO-88 head 1, second follow-up)

- **Context:** After the same-day #1288 cherry-pick fixed the *quant/prefill*
  corruption (sidecar `mlxvlm-macos-arm64-88d260c`), live testing of
  `gemma-4-12B-4bit` (`model_type: gemma4_unified`, an omni vision+audio build)
  against the running dev app's `http://localhost:1337/v1` showed the model was
  **still unusable**, but for two *new*, independent reasons — neither a quant
  issue nor app-side. Empirical findings on the live sidecar:
  - **temp=0 (greedy, the sidecar default):** repetition loops **plus** a flood
    of leaked `<image>`/`<audio>` control tokens.
  - **temp=1.0/top_k=64/top_p=0.95 (Gemma's own recommended sampling):** no
    loops, no leak, but **incoherent rambling** — even "What is the capital of
    France?" was never answered.
  - Suppressing token ids `258883`/`258882` via a request `logit_bias` killed
    the `<image>`/`<audio>` leak instantly; framing the prompt with the
    canonical Gemma turn markers (sent as pre-framed content) made the model
    answer **"The capital of France is Paris."** correctly.

  Two root causes, both **server-side in the fork**, confirmed against the code:
  1. **`suppress_tokens` ignored.** The model ships
     `generation_config.json::suppress_tokens: [258883, 258882]` (its image/audio
     soft-token ids, which must never appear in text). `_collect_stop_tokens`
     mined that file **only** for `eos_token_id`; nothing applied
     `suppress_tokens`, so they leaked.
  2. **No `chat_template`.** This MLX conversion dropped `chat_template` from
     `tokenizer_config.json` (and ships none in `tokenizer.json` or a separate
     file). `prompt_utils.get_chat_template` then falls back to
     `_messages_to_plain_prompt`, which for a single user turn returns the **raw
     content with no `<start_of_turn>` framing**. The instruction-tuned model,
     fed unframed text, does base-style document continuation (echo / ramble)
     instead of answering. `add_special_tokens` only re-adds `<bos>`, not turn
     markers. (All local Gemma 4 MLX builds — E2B/E4B/12B — lack the template.)
- **Decision:** Fix both in `AtomicBot-ai/mlx-vlm` (`mlx_vlm/server/`), no
  Atomic-Chat app change.
  1. **Suppress tokens.** New `_collect_suppress_tokens(model_path)` reads
     `generation_config.json::suppress_tokens` (mirrors the EOS collector's
     hardening: int-only, drops bools). Stored on the generator as
     `self.suppress_tokens` in `_initialize_model`. `_make_logits_processors`
     merges them into the request's `logit_bias` at `-1e9` via `setdefault`
     (large-but-finite to avoid post-temperature NaN; `setdefault` preserves any
     explicit caller bias). Applies on every request through the non-speculative
     continuous-batch path. *(Known limitation: the separate `_run_speculative`
     loop samples without `_make_logits_processors`, so suppression does not yet
     cover speculative decoding — irrelevant for the omni models in scope, which
     run no draft.)*
  2. **Gemma template fallback.** *(Partly superseded — see the 2026-06-08 ADR
     above: the Gemma 3 `<start_of_turn>` template was the **wrong dialect** for
     `gemma4*`, which use `<|turn>`/`<turn|>`; `gemma4*` now get a dedicated
     `GEMMA4_UNIFIED_CHAT_TEMPLATE`. The Gemma 3 template below remains correct
     for `gemma3`/`gemma3n`.)* New module
     `mlx_vlm/server/_chat_templates.py` carries the authoritative Gemma turn
     template (`<start_of_turn>` framing, emits its own `bos_token`), embedded
     **byte-exact** (1532 B, `json.dumps`) from the non-gated published Gemma 3
     IT template (identical turn structure across Gemma 2/3/4 text + image). New
     `_maybe_install_gemma_chat_template(processor, config)` assigns it to the
     processor **and** tokenizer in `_initialize_model`, but **only** when
     `model_type ∈ {gemma3, gemma3n, gemma4, gemma4_unified}` **and** no template
     is already present (never clobbers a real one; idempotent). The existing
     `_cpu_preprocess` gate then sees a non-`None` `chat_template` and flips
     `add_special_tokens` to `False`, so `<bos>` comes from the template — no
     double BOS.
- **Consequences:**
  - **Validated** (without reloading the 12B, to avoid competing with the live
    sidecar): `_collect_suppress_tokens` → `[258882, 258883]`;
    `_maybe_install_gemma_chat_template` builds
    `<bos><start_of_turn>user\n…<end_of_turn>\n<start_of_turn>model\n` for text
    and folds system → first user turn with correct user/model alternation for
    multi-turn; idempotent on second call. End-to-end on the live sidecar,
    proper framing + suppression already yielded a correct, leak-free answer.
    `py_compile` clean; lint clean.
  - **Committed `654a520` and pushed to `origin/main`** (`88d260c..654a520`, no
    force). The push re-triggers `build-mlxvlm-macos.yml` → a new sidecar release
    **`mlxvlm-macos-arm64-654a520`**. **Not yet shipped to the app:** run
    `make build-mlx-server` (or `-if-exists` auto-update) so
    `src-tauri/resources/bin/mlx-server-version.txt` flips `88d260c → 654a520`,
    then restart. Final runtime confirmation on Apple Silicon (coherent answer,
    no `<image>`/`<audio>`, generation halts at `<end_of_turn>`) is pending that
    bump.
  - **Sampling (ATO-99) is a separate, still-open matter.** The template +
    suppress fixes are necessary and sufficient for *coherence and cleanliness*;
    Gemma still benefits from its recommended sampling (temp 1.0 / top_k 64 /
    top_p 0.95) to avoid greedy repetition, which is an app-side default we have
    not yet wired per model family.
  - The Gemma-3 fallback template handles text + image (`<start_of_image>`) but
    not audio framing; the omni audio-input path is not covered by the fallback
    (text/image chat — the failing case — is). Fetching the exact Gemma 4 omni
    template (gated) is a future refinement.
- **Owner:** team.
- **Links:** [ATO-88](https://linear.app/atomicchat/issue/ATO-88),
  [ATO-99](https://linear.app/atomicchat/issue/ATO-99), §4.1 *MLX backend*, the
  2026-06-08 ADR *Cherry-pick mlx-vlm #1288 …* (immediately below), fork commit
  `654a520`, files: `mlx_vlm/server/_chat_templates.py`,
  `mlx_vlm/server/generation.py`
  (`_collect_suppress_tokens`, `_maybe_install_gemma_chat_template`,
  `_make_logits_processors`, `_initialize_model`).

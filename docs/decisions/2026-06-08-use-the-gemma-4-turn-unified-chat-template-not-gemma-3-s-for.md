---
date: 2026-06-08
title: "Use the Gemma 4 `<|turn>` unified chat template (not Gemma 3's) for `gemma4_unified` + stop on `<turn|>` (ATO-88 head 1, third follow-up)"
---

# 2026-06-08 — Use the Gemma 4 `<|turn>` unified chat template (not Gemma 3's) for `gemma4_unified` + stop on `<turn|>` (ATO-88 head 1, third follow-up)

- **Context:** The same-day `654a520` fix (immediately below) installed a Gemma
  **3** turn template (`<start_of_turn>` / `<end_of_turn>` framing) as the
  fallback for *every* template-less Gemma — including `gemma4_unified`. Live
  testing of `gemma-4-12B-4bit` on the resulting sidecar
  (`mlxvlm-macos-arm64-654a520`) showed the model now answered coherently **but
  never stopped** — it emitted its answer and then ran on into an endless
  fabricated self-dialogue (`…<end_of_turn>\n<start_of_turn>user\n…`). Root
  cause: **Gemma 4 does not speak the Gemma 3 turn dialect.** Confirmed against
  the live tokenizer + on-disk configs:
  - Gemma 4's real turn tokens are **`<|turn>` (105)** / **`<turn|>` (106)** with
    reasoning channels **`<|channel>` (100)** / **`<channel|>` (101)** — *not*
    `<start_of_turn>`/`<end_of_turn>`. Encoding the literal string
    `<end_of_turn>` against the Gemma 4 tokenizer splits into 7 sub-word pieces
    and collapses to `<unk>` (id 3) — it is not a token. So the Gemma 3 template
    fed the model out-of-distribution framing; the model echoed the literal
    `<end_of_turn>` **as plain text** and, having no real turn-end token to emit,
    never tripped a stop.
  - `tokenizer_config.json` declares `eot_token: "<turn|>"` (= 106), but
    `generation_config.json::eos_token_id` is just `[1]` (`<eos>`). The previous
    `_collect_stop_tokens` mined only `eos_token_id`, so **106 was never a stop**
    even once correct framing made the model want to emit it.
  - Sibling builds **E2B/E4B** (`model_type: gemma4`) **ship their own
    `chat_template.jinja`** — both already on the `<|turn>` dialect, byte-format
    identical family to the 12B-it template — which is why they worked. **12B**
    (`gemma4_unified`) ships **no template at all** (none in
    `tokenizer_config.json`, no `chat_template.{json,jinja}`), so the fallback is
    mandatory there.
- **Decision:** Fix in `AtomicBot-ai/mlx-vlm` (`mlx_vlm/server/`), no Atomic-Chat
  app change. Three edits:
  1. **Authoritative Gemma 4 template.** `_chat_templates.py` gains
     `GEMMA4_UNIFIED_CHAT_TEMPLATE`, embedded **byte-exact** (17 466 B,
     `json.dumps`) from the published `mlx-community/gemma-4-12B-it-4bit`
     `chat_template.jinja` (`<|turn>`/`<turn|>` framing, `<|channel>` reasoning
     channels, tool macros, and the thinking-disabled generation-prompt seed
     `<|turn>model\n<|channel>thought\n<channel|>`). The Gemma 3 template is
     **kept** as `GEMMA_CHAT_TEMPLATE`, now correctly scoped.
  2. **Family-correct selection.** `_GEMMA_TEMPLATE_MODEL_TYPES` (a flat set) is
     replaced by `_GEMMA_TEMPLATE_BY_TYPE` mapping `gemma3`/`gemma3n` →
     `GEMMA_CHAT_TEMPLATE` and `gemma4`/`gemma4_unified` →
     `GEMMA4_UNIFIED_CHAT_TEMPLATE`. `_maybe_install_gemma_chat_template` picks by
     `model_type`; still install-only-when-absent, idempotent, never clobbers a
     shipped template (so E2B/E4B keep their own).
  3. **Stop on `<turn|>`.** `_collect_stop_tokens` now also reads
     `tokenizer_config.json::eot_token`, resolves it via the tokenizer
     (`convert_tokens_to_ids`, guarded against `<unk>` / bools / negatives), and
     unions the id (106) into the stop set. Generic across the Gemma family —
     Gemma 3's `<end_of_turn>` (also 106) was already covered via
     `generation_config`, so this is additive, not a regression there.
- **Consequences:**
  - **Validated** (isolated, no GPU — tokenizer + template only, to avoid
    fighting the live sidecar): `_collect_stop_tokens(gemma-4-12B-4bit)` →
    `{1, 106}`; the fallback installs the `<|turn>` template (asserted no
    `<start_of_turn>` present); rendering a user turn yields
    `<bos><|turn>user\n…<turn|>\n<|turn>model\n<|channel>thought\n<channel|>` and
    re-encodes to the real single special tokens 105/100/101. `py_compile` clean;
    `ruff format` + `ruff check` clean.
  - **Committed `0a82347`, pushed to `origin/main`** (`654a520..0a82347`, no
    force) → re-triggers `build-mlxvlm-macos.yml` → new sidecar release
    **`mlxvlm-macos-arm64-0a82347`**. **Not yet shipped to the app:** run
    `make build-mlx-server` (or `-if-exists` auto-update) so
    `src-tauri/resources/bin/mlx-server-version.txt` flips `654a520 → 0a82347`,
    then restart. Final runtime confirmation on Apple Silicon (coherent answer,
    no leak, **halts cleanly at `<turn|>`**) is pending that bump.
  - The unified template's thinking-disabled seed (`<|channel>thought\n<channel|>`)
    relies on the fork's existing `in_thinking`/channel handling in
    `server/openai.py`; E2B/E4B exercise the same path with their shipped copy,
    so it is proven for this family.
  - Sampling (ATO-99) remains a separate, still-open app-side matter (Gemma's
    recommended temp 1.0 / top_k 64 / top_p 0.95 not yet wired per family).
- **Owner:** team.
- **Links:** [ATO-88](https://linear.app/atomicchat/issue/ATO-88), §4.1 *MLX
  backend*, the 2026-06-08 ADR *Honor `…suppress_tokens` …* (immediately below,
  whose Gemma-3-template clause this supersedes for `gemma4*`), fork commit
  `0a82347`, files: `mlx_vlm/server/_chat_templates.py`
  (`GEMMA4_UNIFIED_CHAT_TEMPLATE`), `mlx_vlm/server/generation.py`
  (`_GEMMA_TEMPLATE_BY_TYPE`, `_maybe_install_gemma_chat_template`,
  `_collect_stop_tokens`).

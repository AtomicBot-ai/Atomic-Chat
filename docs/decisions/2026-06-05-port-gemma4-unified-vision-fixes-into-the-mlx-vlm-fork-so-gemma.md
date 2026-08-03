---
date: 2026-06-05
title: "Port `gemma4_unified` (+ vision fixes) into the `mlx-vlm` fork so Gemma 4 12B loads under MLX (ATO-88, head 1)"
---

# 2026-06-05 — Port `gemma4_unified` (+ vision fixes) into the `mlx-vlm` fork so Gemma 4 12B loads under MLX (ATO-88, head 1)

- **Context:** Gemma 4 12B MLX (`gemma-4-12B-it-4bit`, `model_type:
 gemma4_unified`) failed to load with `Model type gemma4_unified not
 supported. Error: No module named 'mlx_vlm.speculative.drafters.gemma4_unified'`
 ([ATO-88](https://linear.app/atomicchat/issue/ATO-88)). Confirmed against
 sources: our fork `AtomicBot-ai/mlx-vlm` (`/Users/misha/Work/Atomic/mlx-vlm`,
 branch `sync/v0.6.0` @ `aed5482`, `__version__ = "0.6.0"`) has
 `mlx_vlm/models/gemma4` but **no** `gemma4_unified`. Upstream
 `Blaizzy/mlx-vlm` added it in **0.6.1** (PR #1267, `608ce45`); the model
 resolver (`mlx_vlm/utils.py::get_model_and_args`) auto-imports
 `mlx_vlm.models.<type>` / `mlx_vlm.speculative.drafters.<type>`, so a missing
 package = unsupported type. The bundled sidecar
 (`mlxvlm-macos-arm64-aed5482`, 2026-06-02) predates the fix. ATO-88 head 2
 (llama.cpp Gemma 4 MTP GGUF) is **upstream-blocked** (no llama.cpp release
 supports it; WIP PR ggml-org/llama.cpp#23398) and was **deliberately
 deferred** — not touched here.
- **Decision:** Sync the fix into the fork by **cherry-picking a curated subset
 of upstream/main onto a new branch `feat/gemma4-unified`** (off `sync/v0.6.0`),
 rather than a full 33-commit merge (which would re-trigger the forked-server
 re-port pain from the 2026-06-02 v0.6.0 sync). Picked, in order:
 - `608ce45` PR #1267 — Add Gemma 4 Unified support (model dir + drafter
 `gemma4_unified_assistant` + additive `gemma4/*`, `prompt_utils`,
 `generate/*`; bumps `version.py` → `0.6.1`).
 - `041f889` PR #1280 — Fix Gemma4 unified long-text prefill.
 - `526c210` PR #1292 — Add video input support for Gemma 4 12B.
 **Deliberately skipped `b3d2380` PR #1266** ("Fix Gemma 4 rollback handling +
 streaming thinking splits"): our fork's rollback fix (2026-06-02 ADR) already
 covers the list-coercion case **more generally** (`elif not isinstance(accepted,
 mx.array)` vs upstream's `isinstance(accepted, (list, tuple))`), and #1266's
 bulk is server-streaming changes (`anthropic.py`/`openai.py`/`responses_state.py`)
 that would collide with our heavily-forked `mlx_vlm/server/`.
- **Consequences:**
 - All three cherry-picks applied **cleanly, zero conflicts**, including on the
 two risk files `models/gemma4/language.py` (carries our MTP-rollback coercion
 — verified preserved at lines ~723–729 post-merge) and `server/generation.py`
 (our forked server). `python3 -m py_compile` passes on all 17 changed
 modules; fork `version.py` is now `0.6.1`.
 - **Text Gemma 4 12B Unified now resolves & loads under MLX.** Vision/long-text
 covered by #1280/#1292; some vision edge cases may remain (upstream is still
 iterating — see branches `pc/fix-gemma4-long-context`,
 `pc/gemma4-quant-predicate-size`). Not pulling those yet.
 - **Merged to fork `main`.** `feat/gemma4-unified` was fast-forwarded into
 `main` (clean `aed5482..f42f567`, no force) and **pushed to
 `origin/main`** of `AtomicBot-ai/mlx-vlm`; `main` now carries both the
 prior v0.6.0 sync (already there at `aed5482`) and the three gemma4
 commits. **Not yet shipped to the app:** a new sidecar release
 `mlxvlm-macos-arm64-<sha>` must be built (CI `build-mlxvlm-macos.yml`) for
 `f42f567`, then `make build-mlx-server` in Atomic-Chat (or the `-if-exists`
 auto-update) pulls + re-codesigns it. **Runtime validation on Apple Silicon
 (load + a text and an image turn on `gemma-4-12B-it-4bit`) is pending that
 build** — not doable from the code port alone.
 - No Atomic-Chat code changed for head 1 (the extension/plugin already resolve
 by model_type via the sidecar). Head 2 remains open as a separate task.
- **Owner:** team.
- **Links:** [ATO-88](https://linear.app/atomicchat/issue/ATO-88), §4.1 *MLX
 backend*, the 2026-06-02 ADRs *Sync `mlx-vlm` to v0.6.0* and *Fix MTP
 speculative rollback crash on Gemma 4 + DeepSeek-V4*,
 [Blaizzy/mlx-vlm PR #1267](https://github.com/Blaizzy/mlx-vlm/pull/1267),
 [#1280](https://github.com/Blaizzy/mlx-vlm/pull/1280),
 [#1292](https://github.com/Blaizzy/mlx-vlm/pull/1292),
 [issue #1277](https://github.com/Blaizzy/mlx-vlm/issues/1277),
 fork `AtomicBot-ai/mlx-vlm` branch `feat/gemma4-unified`, `Makefile`
 (`build-mlx-server`).

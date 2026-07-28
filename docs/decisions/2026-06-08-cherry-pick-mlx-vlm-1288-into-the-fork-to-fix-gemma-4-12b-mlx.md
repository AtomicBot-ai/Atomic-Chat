---
date: 2026-06-08
title: "Cherry-pick mlx-vlm #1288 into the fork to fix Gemma 4 12B MLX garbled generation (ATO-88 head 1 follow-up)"
---

# 2026-06-08 — Cherry-pick mlx-vlm #1288 into the fork to fix Gemma 4 12B MLX garbled generation (ATO-88 head 1 follow-up)

- **Context:** After the 2026-06-05 ADR landed `gemma4_unified` in the fork
  (sidecar `mlxvlm-macos-arm64-f42f567`), Gemma 4 12B **loads** under MLX but
  **generates garbage** — incoherent text interleaved with leaked multimodal
  special tokens (`<image>` / `<audio>`) and stray markup. Root cause: the
  shipped sidecar predates upstream **`9c788e4` "Adjust Gemma4 quantization
  predicate" ([Blaizzy/mlx-vlm #1288](https://github.com/Blaizzy/mlx-vlm/pull/1288))**,
  which landed on `upstream/main` *after* our `f42f567`. #1288 carries two
  fixes that both bite this symptom: (1) it **removes the forced 8-bit/group-64
  override on Gemma 4 MLP proj layers** (`mlp.{gate,up,down}_proj`) in
  `gemma4/language.py`'s quantization predicate — a mismatch between that
  override and how the user's 4-bit repo was actually quantized corrupts the
  loaded weights; (2) it adds a model-level **`chunked_prefill_policy`** to
  `gemma4_unified.py` + `gemma4/language.py` (wired through `generate/ar.py`'s
  new `_chunked_prefill_enabled`) that disables chunked prefill for the
  vision-bidirectional / omni path, fixing prompt-prefill corruption.
- **Decision:** Cherry-pick `9c788e4` whole onto a `fix/gemma4-quant-prefill`
  branch off `main` (`f42f567`) in `AtomicBot-ai/mlx-vlm`, rather than a full
  upstream re-sync (which would re-trigger the heavily-forked `server/` +
  `ar.py` re-port pain). The pick applied **cleanly, zero conflicts**
  (auto-merge of `ar.py`, `gemma4/language.py`, `test_generate.py`). Verified
  post-pick: our MTP-rollback coercion is preserved
  (`gemma4/language.py: accepted = mx.array(list(accepted), dtype=mx.int32)`),
  the MLP quant override is gone, `chunked_prefill_policy` is present in both
  modules, `py_compile` clean on all six changed files (incl. the unrelated
  `hunyuan_vl/language.py` RoPE-dtype hunk that rode along in #1288).
- **Consequences:**
  - Fast-forwarded `fix/gemma4-quant-prefill` (`88d260c`) into `main` and
    **pushed to `origin/main`** (`f42f567..88d260c`, no force). The push
    triggers `build-mlxvlm-macos.yml` (paths `mlx_vlm/**`), which will tag a
    new sidecar release **`mlxvlm-macos-arm64-88d260c`**.
  - **Not yet shipped to the app:** Atomic-Chat must run `make build-mlx-server`
    (or the `-if-exists` auto-update) to pull + re-codesign the new binary;
    `src-tauri/resources/bin/mlx-server-version.txt` flips from `f42f567` to
    `88d260c`. **Runtime validation on Apple Silicon** (load `gemma-4-12B-it`,
    confirm coherent output) is pending that sidecar bump — not provable from
    the code pick alone. If garbage persists, the next suspect is the
    downloaded 4-bit repo itself (re-quantize under the new predicate).
  - No Atomic-Chat app/extension/Rust code changed; this is a sidecar-only fix
    (the MLX extension/plugin resolve by `model_type` via the sidecar).
- **Owner:** team.
- **Links:** [ATO-88](https://linear.app/atomicchat/issue/ATO-88), §4.1 *MLX
  backend*, the 2026-06-05 ADR *Port `gemma4_unified` … into the `mlx-vlm`
  fork*, [Blaizzy/mlx-vlm #1288](https://github.com/Blaizzy/mlx-vlm/pull/1288)
  (`9c788e4`), [#1267](https://github.com/Blaizzy/mlx-vlm/pull/1267),
  [#1280](https://github.com/Blaizzy/mlx-vlm/pull/1280),
  [#1292](https://github.com/Blaizzy/mlx-vlm/pull/1292), fork
  `AtomicBot-ai/mlx-vlm` `main` @ `88d260c`, `Makefile` (`build-mlx-server`).

---
date: 2026-06-02
title: "Fix MTP speculative rollback crash on Gemma 4 + DeepSeek-V4 (`'list' object has no attribute 'max'`)"
---

# 2026-06-02 — Fix MTP speculative rollback crash on Gemma 4 + DeepSeek-V4 (`'list' object has no attribute 'max'`)

- **Context:** Enabling **MTP** speculative decoding on a Gemma 4 target
  (e.g. `gemma-4-e4b-it-4bit` + the `*-assistant` drafter) crashed the
  generation thread mid-stream with
  `AttributeError: 'list' object has no attribute 'max'` at
  `mlx_vlm/models/gemma4/language.py::rollback_speculative_cache`
  (a secondary `RuntimeError: There is no Stream(gpu, 1)` followed as the
  `BatchGenerator.__del__` cleanup unwound on the wrong thread). Root cause:
  the MTP batch driver `speculative/mtp.py::_mtp_rounds_batch` passes
  `accepted` as a **Python list** of per-row accepted counts, but Gemma 4's
  (and DeepSeek-V4's) `rollback_speculative_cache` only special-cased `int`
  and otherwise assumed an `mx.array`, immediately calling `accepted.max()`.
  The reference `qwen3_5` implementation already normalized `int` / `mx.array`
  / `list`; Gemma 4 and DeepSeek-V4 did not. (The EAGLE-3 path is unaffected —
  `speculative/eagle3.py` wraps `mx.array(accepted_list)` before the call.)
- **Decision:** Coerce `accepted` to an `int32` `mx.array` up front in both
  `mlx_vlm/models/gemma4/language.py` and
  `mlx_vlm/models/deepseek_v4/language.py`
  (`elif not isinstance(accepted, mx.array): accepted = mx.array(list(accepted), dtype=mx.int32)`),
  matching the qwen3_5 convention. Minimal, local, array-path-preserving.
- **Consequences:**
  - **Gemma 4 MTP and DeepSeek-V4 MTP now run** instead of crashing on the
    first speculative round; the cascade `Stream(gpu, 1)` cleanup error is
    gone once the primary exception no longer fires. Qwen MTP was already
    correct (qwen3_5 hook) and is unchanged. DFlash / EAGLE-3 paths untouched.
  - Fix lives in the **`AtomicBot-ai/mlx-vlm` fork** — it takes effect for
    dev runs from source on the next sidecar restart, and reaches the shipped
    app only after the fork is committed + a new sidecar release is built via
    `build-mlxvlm-macos.yml` (see the v0.6.0 sync ADR below). `py_compile`
    passes on both edited modules.
- **Owner:** team.
- **Links:** the 2026-06-02 v0.6.0 sync ADR below,
  `mlx-vlm` `mlx_vlm/models/gemma4/language.py::rollback_speculative_cache`,
  `mlx-vlm` `mlx_vlm/models/deepseek_v4/language.py::rollback_speculative_cache`,
  `mlx-vlm` `mlx_vlm/models/qwen3_5/language.py` (reference impl),
  `mlx-vlm` `mlx_vlm/speculative/mtp.py::_mtp_rounds_batch`.

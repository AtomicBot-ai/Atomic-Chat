---
date: 2026-07-22
title: "Keep Gemma 4 Unified checkpoints on the multimodal MLX path"
---

# 2026-07-22 — Keep Gemma 4 Unified checkpoints on the multimodal MLX path

- **Context:** `gemma-4-12B-it-4bit` declares the top-level
  `gemma4_unified` architecture but uses `embed_vision`, `vision_embedder`,
  and `embed_audio` weight prefixes. The MLX checkpoint classifier did not
  recognize those prefixes, misclassified the checkpoint as text-only, and
  attempted to load the nested `gemma4_unified_text` type through `mlx-lm`,
  which reported that the architecture was unsupported.
- **Decision:** Treat the three Gemma 4 Unified vision/audio weight prefixes
  as embodied multimodal weights in `mlx-vlm` and pin classification coverage
  for each prefix.
- **Consequences:** Gemma 4 12B Unified now resolves through
  `mlx_vlm.models.gemma4_unified` and loads with its vision/audio modules
  instead of failing through the nonexistent `mlx_lm.models.gemma4_unified_text`
  path. Text-only checkpoints with multimodal metadata remain routed through
  the existing text-only adapter when no embodied multimodal weights exist.
- **Owner:** team.
- **Links:** [`AtomicBot-ai/mlx-vlm`](https://github.com/AtomicBot-ai/mlx-vlm),
  [`mlx_vlm/utils.py`](../mlx-vlm/mlx_vlm/utils.py),
  [`mlx_vlm/tests/test_utils.py`](../mlx-vlm/mlx_vlm/tests/test_utils.py).

---

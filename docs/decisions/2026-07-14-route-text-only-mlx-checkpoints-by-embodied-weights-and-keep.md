---
date: 2026-07-14
title: "Route text-only MLX checkpoints by embodied weights and keep failed loads off the session-map lock (ATO-295)"
---

# 2026-07-14 — Route text-only MLX checkpoints by embodied weights and keep failed loads off the session-map lock (ATO-295)

- **Context:** Ornith-like MLX checkpoints can retain a VLM wrapper in
 `config.json` (`vision_config`, image token ids, or a conditional-generation
 architecture) while shipping only language-model weights. `mlx-vlm` selected
 the VLM class before inspecting those weights, so strict loading failed on
 absent vision tensors. Atomic Chat also held the MLX session-map mutex across
 validation, process spawn, and readiness waits; `/v1/models` uses that map and
 could therefore block behind a long or failed load. The desktop extension
 compounded the mismatch by advertising vision from stale `mmproj_path` or
 processor/config hints without checking the indexed weight names.
- **Decision:** In `mlx-vlm`, classify a checkpoint before model-class
 construction using both config and loaded safetensors keys. Route through the
 existing `mlx_vlm.models.text_only` adapter when a nested text model is
 declared and no embodied vision/audio/projector weights exist, and pass the
 nested `text_config.model_type` to `mlx-lm`. Keep the normal VLM path and
 strict weight loading whenever multimodal weights are present; do not use
 `strict=False` as recovery. In `tauri-plugin-mlx`, serialize loads with a
 dedicated `load_operation` mutex and hold `mlx_server_process` only for final
 insert/remove/read operations. In the MLX extension, derive the live vision
 capability from `vision_config` plus
 `model.safetensors.index.json::weight_map` when available, including for
 already-imported models.
- **Consequences:** Text-only checkpoints wrapped in VLM metadata load through
 `mlx-lm`, while genuinely incomplete VLMs still fail diagnostically under
 strict loading. Failed or slow loads do not create phantom sessions and no
 longer monopolize the map read by `/v1/models`. Vision reporting is
 conservative for indexed checkpoints; single-file safetensors remain under
 the Python loader's authoritative runtime classification because no new
 desktop parser or IPC was added. Verified by 35 targeted `mlx-vlm` tests,
 8 `tauri-plugin-mlx` tests, 7 capability tests, and the MLX extension build.
- **Owner:** team.
- **Links:** [ATO-295](https://linear.app/atomicchat/issue/ATO-295),
 [AtomicBot-ai/mlx-vlm](https://github.com/AtomicBot-ai/mlx-vlm),
 [`src-tauri/plugins/tauri-plugin-mlx/src/state.rs`](src-tauri/plugins/tauri-plugin-mlx/src/state.rs),
 [`src-tauri/plugins/tauri-plugin-mlx/src/commands.rs`](src-tauri/plugins/tauri-plugin-mlx/src/commands.rs),
 [`extensions/mlx-extension/src/visionCapability.ts`](extensions/mlx-extension/src/visionCapability.ts),
 [`extensions/mlx-extension/src/index.ts`](extensions/mlx-extension/src/index.ts).

---

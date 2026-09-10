---
date: 2026-08-03
title: "Store MLX weight shards under their Hub filenames"
---

# 2026-08-03 — Store MLX weight shards under their Hub filenames

- **Context:** The Hub/Setup MLX flow picks the repo's first `*.safetensors` sibling as the "main" weight and hands its URL to `mlx-extension.import()`, which saved it under a fixed `model.safetensors` while every other file kept its Hub name. For a sharded checkpoint the main weight *is* `model-00001-of-000NN.safetensors`, so the shard `model.safetensors.index.json` points at never existed on disk and mlx-vlm rejected the load with all shard-1 parameters reported missing. Verified on `mlx-community/gemma-4-12B-it-4bit` (520 missing parameters); single-shard repos were unaffected because their Hub name already is `model.safetensors`.
- **Decision:** Derive the local filename from the download URL's basename (`mlxMainWeightFileName`), accepting only a plain `*.safetensors` name and falling back to `model.safetensors` otherwise, and write that same name into `model.yml`'s `model_path` / `mmproj_path`.
- **Consequences:** Newly downloaded sharded MLX models load. `model_path` now varies per checkpoint, which is safe because `normalize_mlx_model_path` resolves a weight file to its parent directory and `delete` derives the model directory from the path's parent. Installs that already hold the broken layout are not repaired by this change — they must be re-downloaded. The filename allow-list keeps a crafted Hub URL from escaping the model directory.
- **Owner:** team
- **Links:** `extensions/mlx-extension/src/weightFileName.ts`, `extensions/mlx-extension/src/index.ts`, `web-app/src/containers/MlxModelDownloadAction.tsx`, `src-tauri/plugins/tauri-plugin-mlx/src/commands.rs`

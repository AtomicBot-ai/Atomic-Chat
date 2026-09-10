---
date: 2026-08-03
title: "Repair mis-named MLX shards in place on load"
---

# 2026-08-03 — Repair mis-named MLX shards in place on load

- **Context:** Deriving the weight filename from the download URL fixes new downloads only. Every sharded MLX model already on disk keeps its first shard under the legacy `model.safetensors`, so it still fails to load with all shard-1 parameters reported missing (`mlx-community/gemma-4-12B-it-4bit`: 520 missing). Re-downloading is the only alternative and costs several GB per model for what is a rename.
- **Decision:** Before starting the sidecar, `performLoad` inspects the weights directory: if `model.safetensors.index.json` names exactly one shard that is absent while the unreferenced legacy `model.safetensors` is present, rename the file to the indexed shard name and repoint `model.yml`'s `model_path` / `mmproj_path`. Two or more absent shards mean an interrupted download, which no rename can mend, so nothing is touched. Repair failures are logged and swallowed so the load still surfaces its own error.
- **Consequences:** Existing broken installs heal on the next load attempt with no re-download and no migration step. The check costs one `existsSync`, one small JSON read and one `readdir` per load, and is a no-op for single-file checkpoints (no index) and for imported models (whose `model_path` is a directory). Because the rename is inferred from the index rather than from tensor contents, the guard on "exactly one absent shard" is what keeps it from mislabelling a partial download.
- **Owner:** team
- **Links:** `extensions/mlx-extension/src/shardRepair.ts`, `extensions/mlx-extension/src/index.ts`, `docs/decisions/2026-08-03-store-mlx-weight-shards-under-their-hub-filenames.md`

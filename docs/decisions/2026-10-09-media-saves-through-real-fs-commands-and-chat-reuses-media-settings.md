---
date: 2026-10-09
title: "Media saves through real fs commands; chat reuses the Media page's settings"
---

# 2026-10-09 — Media saves through real fs commands; chat reuses the Media page's settings

- **Context:** Generated media never reached the Library. The frontend wrote files through `fs.writeBlob` and deleted them through `fs.unlinkSync`, and no Rust command backed either, so every save threw and was swallowed. The Library and previews were empty as a result.
- **Decision:** Add `write_binary_file`, `copy_file` and `remove_file` to `core/filesystem`, and use them from the media filesystem port. Add a user-chosen output folder (readable names), Save as, Show in folder and Rename. Chat gets image/video modes that run the same job manager with the settings last used on the Media page (model, device, parameters; never the prompt or seed) and show the result inline from `message.metadata.media`. Add a GPU Placement setting (manual, single, one per GPU, several small per GPU, spread) with `--tensor-split` to both llama.cpp runtimes.
- **Consequences:** `write_binary_file` and `remove_file` accept any absolute path, because the output folder is the user's choice; `remove_file` only deletes a single regular file. Multi-model placements only coexist when Auto-Unload is off. The Rust changes were not compiled in the authoring environment (no network for crates) and need `cargo check` plus a real multi-GPU run.
- **Owner:** team
- **Links:** `src-tauri/src/core/filesystem/commands.rs`, `web-app/src/services/media/chatGeneration.ts`, `extensions/*/src/gpuPlacement.ts`

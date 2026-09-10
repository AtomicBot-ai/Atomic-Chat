---
date: 2026-07-13
title: "Detect embedded Qwen MTP from canonical GGUF metadata"
---

# 2026-07-13 — Detect embedded Qwen MTP from canonical GGUF metadata

- **Context:** The `llamacpp-upstream` load and Settings gates treated a Qwen
  model as built-in MTP-capable only when its Atomic Chat model id contained
  `mtp`. Valid combined GGUFs can be imported under ordinary filenames, so
  their embedded MTP head was silently disabled despite the file carrying the
  metadata llama.cpp itself uses.
- **Decision:** Read `general.architecture`,
  `<architecture>.nextn_predict_layers`, and `<architecture>.block_count` from
  the existing GGUF metadata IPC. Accept embedded MTP only for implemented
  `qwen35` / `qwen35moe` architectures when
  `block_count > nextn_predict_layers > 0`. Use this capability check in both
  the load-time gate and Settings UI. Keep Gemma 4 on its separate downloaded
  `mtp_draft_path` branch, and keep the built-in Qwen launch arguments at
  `--spec-type draft-mtp --spec-draft-n-max 2` without `--model-draft`.
- **Consequences:** Correct combined Qwen GGUFs use MTP regardless of repository
  or filename. Missing, malformed, or unsupported metadata conservatively
  disables MTP, while the existing one-shot retry without MTP remains a final
  load safeguard. No Rust parser, IPC shape, or speculative-window change.
- **Owner:** team.
- **Links:** [`extensions/llamacpp-upstream-extension/src/util.ts`](extensions/llamacpp-upstream-extension/src/util.ts),
  [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts),
  [`web-app/src/routes/settings/providers/$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx),
  [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs).

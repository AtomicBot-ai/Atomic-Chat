---
date: 2026-07-10
title: "Let users choose the `llamacpp-upstream` DFlash draft quantization before download"
---

# 2026-07-10 — Let users choose the `llamacpp-upstream` DFlash draft quantization before download

- **Context:** The upstream DFlash registry initially pinned one Q4_K_M draft
  per supported target. All three compatible Hugging Face repositories publish
  several mainline-llama.cpp GGUF quantizations, but enabling DFlash downloaded
  Q4_K_M immediately with no user choice. The existing MLX DFlash dialog
  already established a quant-picker pattern.
- **Decision:** Store every verified compatible draft variant (quant label,
  filename, SHA-256, and byte size) in `dflashRegistry.ts`, keep Q4_K_M as the
  default, and expose the matching variants through the extension engine.
  Enabling DFlash for a supported active target now opens a draft-quant picker
  before download. Non-default variants use quant-qualified local filenames;
  the selected path is written to the existing `dflash_draft_path` field in
  `model.yml`.
- **Consequences:** Users can trade draft memory/disk usage against quality
  before downloading, while automatic/lazy setup remains backward-compatible
  and defaults to Q4_K_M. Previously downloaded Q4_K_M drafts keep their
  existing `dflash-draft.gguf` path. Selecting another quant keeps the old file
  on disk; automatic cleanup of unselected draft variants is deliberately out
  of scope.
- **Owner:** team.
- **Links:** [`extensions/llamacpp-upstream-extension/src/dflashRegistry.ts`](extensions/llamacpp-upstream-extension/src/dflashRegistry.ts),
  [`web-app/src/containers/dialogs/LlamacppDflashDraftDialog.tsx`](web-app/src/containers/dialogs/LlamacppDflashDraftDialog.tsx),
  [`web-app/src/routes/settings/providers/$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx).

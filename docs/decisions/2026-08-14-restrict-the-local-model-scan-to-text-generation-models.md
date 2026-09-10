---
date: 2026-08-14
title: "Restrict the local-model scan to text-generation models"
---

# 2026-08-14 — Restrict the local-model scan to text-generation models

- **Context:** the onboarding scanner treated every `.gguf` file (and every
  safetensors folder) in the LM Studio / HF / Unsloth / Ollama caches as a
  runnable chat model. Those caches also hold embedding and reranker weights,
  pulled in by other tools or by RAG workflows. Since the auto-start picks the
  *smallest* runnable candidate, a small embedding model such as
  `unsloth/bge-small-en-v1.5-GGUF` won on almost every machine that had one:
  `llama-server` aborted on `GGML_ASSERT(n_outputs_max <= cparams.n_outputs_max)`
  and first launch ended on a crash dump instead of a chat.
- **Decision:** `scanLocalModels()` classifies each candidate before returning
  it and drops everything that is not a text generator. GGUF files are judged by
  their header: a non-generative `general.architecture` (bert family, CLIP,
  `t5encoder`, `wavtokenizer-dec`, the dedicated `*-embedding` architectures), a
  `{arch}.pooling_type` other than NONE, or a `{arch}.classifier.output_labels`
  key. Safetensors/MLX folders are judged by `config.json` (`model_type` of an
  encoder-only family, or a classifier head in `architectures`). Anything that
  cannot be classified is kept.
- **Consequences:** onboarding can no longer auto-start a model that is unable
  to serve `/v1/chat/completions`, and the Settings scan card stops offering
  them for import. The scan now reads one file header per candidate (bounded to
  four in flight), which costs a few milliseconds each and stays well inside the
  existing 4s scan budget. The classifier is deliberately permissive: an
  unreadable header or an unknown architecture still shows up, so a brand-new
  model family is never hidden. Embedding models are still installable through
  the Hub — this only changes what the scanner volunteers.
- **Owner:** `team`
- **Links:** `web-app/src/services/models/localScan.ts`,
  `web-app/src/services/models/__tests__/localScan.test.ts`,
  `docs/decisions/2026-08-12-auto-start-a-model-found-on-disk-instead-of-showing-the-picker.md`

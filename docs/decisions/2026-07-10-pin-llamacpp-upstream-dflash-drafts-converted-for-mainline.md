---
date: 2026-07-10
title: "Pin `llamacpp-upstream` DFlash drafts converted for mainline llama.cpp"
---

# 2026-07-10 — Pin `llamacpp-upstream` DFlash drafts converted for mainline llama.cpp

- **Context:** The original DFlash GGUF registry mixed incompatible conversion
  formats. `Anbeeld/Qwen3.5-9B-DFlash-GGUF` identifies its architecture as
  `dflash-draft` and targets BeeLlama.cpp, so official llama.cpp `b9937`
  rejected it with `unknown model architecture: 'dflash-draft'`. The
  `spiritbuun/Qwen3.6-27B-DFlash-GGUF` entry was likewise converted with
  `spiritbuun/buun-llama-cpp` for its fork-specific Qwen 3.6 sliding-window
  metadata. A direct test of
  `onion515/Qwen3.5-9B-DFlash-GGUF` Q4_K_M against the official `b9937`
  binary loaded successfully and generated with non-zero speculative
  acceptance (`draft_n=285`, `draft_n_accepted=33`).
- **Decision:** Keep the three strict target-family matchers, but pin only
  repositories whose model cards identify architecture `dflash` and explicit
  mainline llama.cpp `b9831+` compatibility. Qwen 3.5 9B now uses
  `onion515/Qwen3.5-9B-DFlash-GGUF`; Qwen 3.6 27B now uses
  `williamliao/qwen3.6-27B-DFlash-GGUF`; Qwen 3.6 35B-A3B keeps the already
  compatible `williamliao/Qwen3.6-35B-A3B-DFlash-GGUF`. Pin each Q4_K_M
  filename, byte size, and Hugging Face LFS SHA-256 from the live API.
- **Consequences:** Fresh DFlash downloads for all three registered Qwen
  families now use the mainline `dflash` GGUF schema expected by the official
  upstream provider instead of fork-only architecture names. Existing
  `dflash-draft.gguf` files are not migrated or revalidated automatically;
  users who already downloaded an incompatible draft must remove it and run
  DFlash setup again. Automatic draft migration is outside this registry-only
  change.
- **Owner:** team.
- **Links:** [llama.cpp PR #22105](https://github.com/ggml-org/llama.cpp/pull/22105),
  [`extensions/llamacpp-upstream-extension/src/dflashRegistry.ts`](extensions/llamacpp-upstream-extension/src/dflashRegistry.ts),
  [`extensions/llamacpp-upstream-extension/src/dflashRegistry.test.ts`](extensions/llamacpp-upstream-extension/src/dflashRegistry.test.ts),
  [onion515/Qwen3.5-9B-DFlash-GGUF](https://huggingface.co/onion515/Qwen3.5-9B-DFlash-GGUF),
  [williamliao/qwen3.6-27B-DFlash-GGUF](https://huggingface.co/williamliao/qwen3.6-27B-DFlash-GGUF),
  [williamliao/Qwen3.6-35B-A3B-DFlash-GGUF](https://huggingface.co/williamliao/Qwen3.6-35B-A3B-DFlash-GGUF).

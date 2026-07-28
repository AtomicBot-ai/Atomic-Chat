---
date: 2026-05-19
title: "Use `AtomicBot-ai/atomic-llama-cpp-turboquant` as the LLM backend"
---

# 2026-05-19 — Use `AtomicBot-ai/atomic-llama-cpp-turboquant` as the LLM backend

- **Context:** We need a cross-platform LLM runtime (Metal / CUDA / Vulkan /
  HIP / CPU) with aggressive KV compression and speculative decoding so
  long-context chat fits in laptop / desktop budgets.
- **Decision:** Use our fork
  [`AtomicBot-ai/atomic-llama-cpp-turboquant`](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant),
  branch `feature/turboquant-kv-cache`. Default KV cache settings on
  supported platforms: `-ctk turbo3 -ctv turbo3 -fa on`. Recommend
  Gemma 4 MTP and Qwen 3.6 NextN speculative decoding where the target
  family supports it.
- **Consequences:** Single binary serves all desktop OSes; +30–50 %
  short-prompt throughput on Gemma 4 26B-A4B / 31B and +24–36 % on
  Qwen 3.6 35B-A3B MoE. Cost: we maintain a llama.cpp fork (credit:
  @TheTom for the original TurboQuant work) and must rebase against
  `ggml-org/llama.cpp` periodically.
- **Owner:** team.
- **Links:** [AtomicBot-ai/atomic-llama-cpp-turboquant](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant),
  `extensions/llamacpp-extension/`, `MTP.md`, `NEXTN.md`,
  `docs/speculative.md` (in the backend repo).

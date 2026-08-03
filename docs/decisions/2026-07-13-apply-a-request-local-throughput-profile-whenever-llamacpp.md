---
date: 2026-07-13
title: "Apply a request-local throughput profile whenever `llamacpp-upstream` DFlash is enabled"
---

# 2026-07-13 — Apply a request-local throughput profile whenever `llamacpp-upstream` DFlash is enabled

- **Context:** The initial DFlash request override forced only
  `temperature: 0`. The upstream llama.cpp DFlash reference command also uses
  `top-k 1`, and DFlash acceptance drops when thinking generation or sampling
  penalties move target selection away from the draft model's predictions.
- **Decision:** Extend the request-local DFlash override to set
  `temperature: 0`, `top_k: 1`, `repeat_penalty: 1`,
  `presence_penalty: 0`, and `frequency_penalty: 0`. Independently force
  `chat_template_kwargs.enable_thinking: false` and `reasoning_budget: 0`.
  Preserve all unrelated request parameters and never write these overrides to
  the global Sampling or General settings stores. Keep DFlash block size and
  draft quantization user-selectable.
- **Consequences:** DFlash requests use deterministic, non-thinking generation
  with neutral penalties to maximize draft acceptance and per-request
  throughput. Disabling DFlash or switching providers immediately restores the
  user's persisted sampling and reasoning choices.
- **Owner:** team.
- **Links:** [llama.cpp DFlash PR #22105](https://github.com/ggml-org/llama.cpp/pull/22105),
  [`web-app/src/lib/custom-chat-transport.ts`](web-app/src/lib/custom-chat-transport.ts),
  [`web-app/src/lib/__tests__/dflashToolIsolation.test.ts`](web-app/src/lib/__tests__/dflashToolIsolation.test.ts).

---
date: 2026-07-13
title: "Force greedy sampling for `llamacpp-upstream` DFlash requests"
---

# 2026-07-13 — Force greedy sampling for `llamacpp-upstream` DFlash requests

- **Context:** DFlash speculative decoding on the upstream llama.cpp provider
  requires deterministic target sampling, while Atomic Chat's global sampling
  defaults include a non-zero temperature.
- **Decision:** At request construction, when the selected provider is
  `llamacpp-upstream` and its DFlash setting is enabled, override only the
  effective request parameters with `temperature: 0`. Do not modify the
  persisted global Sampling store.
- **Consequences:** DFlash requests use greedy sampling regardless of the
  user's global temperature. Disabling DFlash or switching providers
  immediately restores the user's existing sampling value because it was
  never overwritten.
- **Owner:** team.
- **Links:** [`web-app/src/lib/custom-chat-transport.ts`](web-app/src/lib/custom-chat-transport.ts),
  [`web-app/src/lib/__tests__/dflashToolIsolation.test.ts`](web-app/src/lib/__tests__/dflashToolIsolation.test.ts).

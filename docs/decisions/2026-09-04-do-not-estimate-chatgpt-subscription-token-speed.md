---
date: 2026-09-04
title: 'Do not estimate ChatGPT subscription token speed'
---

# 2026-09-04 — Do not estimate ChatGPT subscription token speed

- **Context:** the ChatGPT subscription bridge maps Responses API
  `output_tokens` into Chat Completions usage, but the endpoint supplies no
  decode timing. That count can include hidden reasoning generated before the
  first visible delta, while the frontend's fallback timer starts at the first
  visible text or reasoning-summary delta. Dividing the aggregate count by
  that shorter interval produced impossible rates such as 1,116 tokens over
  3.837 visible-stream seconds being shown as 290.9 tok/s.
- **Decision:** do not use the visible-delta wall-clock fallback for the
  `chatgpt` subscription provider. Omit token-speed metadata when no
  provider-reported decode rate exists, while continuing to show the reported
  output-token count.
- **Consequences:** subscription responses no longer claim a decode speed that
  cannot be derived from their wire data. Local provider-reported TPS and the
  existing fallback for other providers are unchanged. ChatGPT subscription
  TPS can return if its upstream contract exposes reliable decode timing.
- **Owner:** @xDenside
- **Links:** `web-app/src/lib/custom-chat-transport.ts`,
  `web-app/src/containers/TokenSpeedIndicator.tsx`,
  `src-tauri/src/core/server/chat_to_responses_shim.rs`

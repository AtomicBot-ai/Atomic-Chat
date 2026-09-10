---
date: 2026-07-24
title: "Restrict Agent mode to local llama.cpp providers"
---

# 2026-07-24 — Restrict Agent mode to local llama.cpp providers

- **Context:** Agent mode could still be selected or retained while an MLX or
  cloud-provider model was active, although the Rust Agent loop currently
  supports only the two local llama.cpp providers.
- **Decision:** Treat only `llamacpp` and `llamacpp-upstream` as Agent-capable.
  Disable the sidebar Agent selector for every other provider, clear stale
  Agent mode when the provider changes, and reject non-llama.cpp Agent runs
  at the thread boundary.
- **Consequences:** MLX and cloud models remain available for ordinary Chat
  but cannot enter Agent mode. Existing Agent threads fail closed if their
  selected provider is no longer one of the two local llama.cpp providers.
- **Owner:** team.
- **Links:** [`web-app/src/components/left-sidebar/index.tsx`](web-app/src/components/left-sidebar/index.tsx),
  [`web-app/src/containers/ChatInput.tsx`](web-app/src/containers/ChatInput.tsx),
  [`web-app/src/routes/threads/$threadId.tsx`](web-app/src/routes/threads/$threadId.tsx).

---
date: 2026-09-17
title: 'Keep live reasoning bounded through completion'
---

# 2026-09-17 — Keep live reasoning bounded through completion

- **Context:** The message switched from a capped scroller to `h-auto` as soon as streaming ended. Radix retained the closing plain-text trace, briefly expanding a 128 px viewport to over 1,700 px. A top-only mask and unpadded tail also left the bottom edge visibly clipped.
- **Decision:** Let a reasoning-context viewport own the live and closed geometry. Reserve six text lines plus vertical padding (136 px at Medium, 166 px at Extra Large), collapse that explicit height over 150 ms, and allow natural height only when a reader opens completed reasoning. Fade only edges that have hidden content and keep the latest line above the bottom padding.
- **Consequences:** Short live traces reserve empty space, while token growth cannot move the conversation. Tail writes remain coalesced to one animation frame and stop when the reader scrolls back; resize observation also handles font and width changes. Closing never expands the trace or parses its full Markdown. Reduced motion disables the height transition. The existing conversation `resize="instant"` policy is sufficient and stays unchanged. The existing 4,000-character live render window remains; full reasoning is available on manual expansion.
- **Owner:** team.
- **Links:** `web-app/src/components/ai-elements/reasoning.tsx`, `web-app/src/containers/MessageItem.tsx`, `web-app/src/hooks/useReasoningAutoScroll.ts`, `web-app/src/containers/MessageItem.layout.test.tsx`.

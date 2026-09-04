---
date: 2026-09-04
title: 'Bound streaming reasoning render cost'
---

# 2026-09-04 — Bound streaming reasoning render cost

- **Context:** A self-hosted model streamed roughly 9,500–12,000 reasoning
  tokens at about 76 tokens/s. The macOS WebKit content process then saturated
  a CPU core and the UI stopped responding. Every delta reparsed and animated
  the complete growing reasoning string through Streamdown, while the
  reasoning view also forced an unthrottled scroll layout.
- **Decision:** While reasoning streams, render only its most recent 16,000
  characters as plain text. Parse the complete Markdown once after completion,
  without animation. Coalesce auto-scroll to one animation-frame update and
  change tail-follow state only in response to actual panel scroll events.
- **Consequences:** Streaming render and layout cost remain bounded while the
  completed reasoning stays intact and formatted. Earlier live reasoning is
  hidden only until generation finishes. Automatic tail-following remains
  responsive, and readers may still pause it by scrolling upward.
- **Owner:** team.
- **Links:**
  [`web-app/src/components/ai-elements/reasoning.tsx`](../../web-app/src/components/ai-elements/reasoning.tsx),
  [`web-app/src/hooks/useReasoningAutoScroll.ts`](../../web-app/src/hooks/useReasoningAutoScroll.ts),
  [`web-app/src/routes/threads/$threadId.tsx`](../../web-app/src/routes/threads/$threadId.tsx).

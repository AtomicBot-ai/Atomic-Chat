---
date: 2026-09-04
title: 'Bound streaming reasoning render cost'
---

# 2026-09-04 — Bound streaming reasoning render cost

- **Context:** Long reasoning traces saturated the macOS WebKit content
  process and the app stopped responding after two to three minutes of
  thinking — with a self-hosted model and with a remote one alike, so the cost
  is in the renderer, not in inference. Every delta re-ran
  `parseIncompleteMarkdown` and the block lexer over the whole growing trace,
  and the reasoning view forced an unthrottled scroll layout on top. Cost of a
  single streamed delta measured in WebKit, by trace length: 3ms at 2k
  characters, 42ms at 20k, 147ms at 40k, 314ms at 60k, 549ms at 80k. The
  growth is superlinear, so the frame budget is gone within the first minute
  and by minute three a single token costs half a second.
- **Decision:** While reasoning streams, render only its most recent 4,000
  characters as plain text — the panel is 128px tall while a turn runs, so the
  window only covers scroll-back. Parse the complete Markdown once, and only
  while a reader actually has the panel open. Coalesce auto-scroll to one
  animation-frame update, and change tail-follow state only in response to a
  scroll the reader performed: a programmatic tail scroll emits `scroll` too,
  delivered a frame later once the next chunk has already grown
  `scrollHeight`, and measuring the distance then ends tail-following for the
  rest of the turn.
- **Consequences:** Streaming render and layout cost are constant instead of
  superlinear in trace length: ~1ms per delta at any length, against 314ms at
  60k characters. The completed reasoning stays intact and formatted. Earlier
  live reasoning is hidden until generation finishes. The panel auto-closes
  when a turn ends, so the full parse — 657ms on an 80k-character trace — no
  longer runs for a subtree that is discarded on the next commit.
- **Not covered:** the answer body takes the same path with a heavier plugin
  set (gfm, math, katex, harden, code, mermaid, cjk), measured at 41ms per
  delta on a 20k-character answer and 317ms at 60k, so a long enough answer
  still reaches the same wall. Plain text is not an option there. Chat updates
  are throttled from 16ms to 50ms, which divides the cost and keeps
  mid-length answers inside budget; making it independent of answer length
  needs the stable prefix to stop being re-parsed, which is a change inside
  the Markdown renderer.
- **Owner:** team.
- **Links:**
  [`web-app/src/components/ai-elements/reasoning.tsx`](../../web-app/src/components/ai-elements/reasoning.tsx),
  [`web-app/src/hooks/useReasoningAutoScroll.ts`](../../web-app/src/hooks/useReasoningAutoScroll.ts),
  [`web-app/src/routes/threads/$threadId.tsx`](../../web-app/src/routes/threads/$threadId.tsx).

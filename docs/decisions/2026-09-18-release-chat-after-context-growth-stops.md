---
date: 2026-09-18
title: "Release chat after context growth stops"
---

# 2026-09-18 — Release chat after context growth stops

- **Context:** An overflow can reach the chat error state before automatic context growth begins. When the model uses Fit or has reached its maximum context, `growModelContext` declines to reload it. The status effect has already observed `error`, so it does not clear the later growth indicator or active request. The input remains disabled.
- **Decision:** When growth cannot proceed, clear the growth indicator, active request and pending continuation in the growth handler itself. Keep the overflow explanation visible and let the user send another message. A successful growth still regenerates after reload.
- **Consequences:** Fit and maximum-context failures no longer strand the conversation. The desktop e2e scenario now checks recovery as an ordinary passing assertion rather than an expected failure.
- **Owner:** team
- **Links:** `web-app/src/routes/threads/$threadId.tsx`, `tests/e2e/desktop/context-growth.spec.ts`

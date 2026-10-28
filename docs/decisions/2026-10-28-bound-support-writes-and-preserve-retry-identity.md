---
date: 2026-10-28
title: "Bound support writes and preserve retry identity"
---

# 2026-10-28 — Bound support writes and preserve retry identity

- **Context:** Support writes are serialized to preserve typing order. A POST that never settles blocked every later message, with no Retry action until an app restart.
- **Decision:** Give conversation creation and message sending separate 30-second abortable deadlines. Race the transport against the deadline so even a transport that ignores abort releases the queue. Treat timeout as a retryable failure, preserve the original `client_id`, ignore late transport results, and do not fall back to a second transport after abort.
- **Consequences:** A slow request can be reported as failed after the server has accepted it; polling and retries merge by the same client identity to avoid duplicate messages. Later queued messages can progress without restarting the app. Thirty seconds bounds each network write, not time spent waiting behind earlier messages.
- **Owner:** team.
- **Links:** [Support store](../../web-app/src/stores/support-chat-store.ts), [support transport](../../web-app/src/services/support/client.ts), [deadline and deduplication tests](../../web-app/src/stores/__tests__/support-chat-store.test.ts), [original support design](2026-10-26-chat-with-the-team-through-a-support-relay.md).

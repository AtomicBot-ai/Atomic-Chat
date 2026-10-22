---
date: 2026-10-21
title: "List unwatched Local API requests in Activity, without previews"
---

# 2026-10-21 — List unwatched Local API requests in Activity, without previews

- **Context:** Server → Activity says "Requests to the server while Atomic Chat
  is open", but it listed only requests that arrived while a Server page
  (Overview or Activity) was mounted. The core announces a request
  (`api:request` `started`, with the prompt preview) only while the app tells
  it the screen watches (ATO-113), and decides that when the request arrives;
  the app's inspector dropped a `finished` event for a request it had not seen
  start. So requests sent right after the server came up — from a chat, or
  while the page was still mounting — never appeared (QA F-01 on 2.2.23).
  Separately, the feed read its snapshot before attaching its listeners, so a
  request that started in between was in neither until the page was reopened.
- **Decision:** A core `finished` event for a request the inspector never saw
  start becomes a finished row built from the analytics observation the event
  already carries for every product request: endpoint, method, model, stream,
  status, error kind, time to headers. It has no prompt or reply preview —
  none was collected — and carries the finish time as its time. The webview
  feed attaches its listeners first, holds what they hear while a snapshot is
  read, and replays it on top; a start for a row already listed is skipped.
- **Consequences:** Activity lists every product request the core served while
  the app ran, as the page says; only the ones that came while it watched show
  prompt and reply. ATO-113 is unchanged: previews are still collected only
  while a screen watches, and the ring stays memory-only. Rows for unwatched
  requests have no duration, so they count toward the request and error tiles
  but not latency or throughput. The app's own proxy (mobile) still records
  only while watched. No core change: this uses the pinned core's events.
- **Owner:** team
- **Links:** `src-tauri/src/core/server/request_inspector.rs`
  (`record_unannounced_core_request`), `web-app/src/hooks/useApiServerLogFeed.ts`,
  `web-app/src/hooks/useApiServerLog.ts`,
  [Bind the API inspector's emitter on the core event path](2026-09-18-bind-the-api-inspector-emitter-on-the-core-event-path.md)

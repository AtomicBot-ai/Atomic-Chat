---
date: 2026-10-26
title: "Keep the Activity log live while no Server page is open, and say why a request has no text"
---

# 2026-10-26 — Keep the Activity log live while no Server page is open, and say why a request has no text

- **Context:** QA 2.2.25 F-01 / NEW-05: "Send test request" on Server → Connections answered
  200 OK in 1.2 s; Activity, opened right after, showed 0 requests; Refresh listed the request
  as Completed with every timing and token a dash, and its details said "No prompt captured" /
  "No reply captured". The core reports the request on the event stream at once and the Rust
  ring records it at once (checked against the compiled core with a keep-alive client). But the
  webview listened to the request channels only while Overview or Activity was mounted: the
  store kept the list it last showed, and a page opened later rendered that list until its
  snapshot came back. The core sent no finish fields for a request nobody watched (core ADR
  2026-10-26-report-timings-and-token-counts-for-unwatched-api-requests), so the row had none.
  And "No prompt captured" read as a fault, when ATO-113 keeps prompt and reply text only while
  a Server page watches.
- **Decision:** The request channels are listened to for the whole app run
  (`useApiServerLogLive`, mounted once in `GlobalEventHandler`); pages share that one set of
  listeners (refcounted, the last holder detaches) and still watch, read the ring on mount and
  refresh. Only a page watching switches previews on — listening does not. A core `finished`
  for a request the inspector never saw start takes the core's finish fields when it sends them
  (duration, time to first token, tokens, rates) and dates the row at finish − duration; with an
  older core it is built from the observation as before. Such a row is marked `unwatched` (ring
  record and started event); its details say the text was not recorded because no Server page
  was open, and to keep the page open and send the request again. Any reply preview on an
  unwatched row is dropped in Rust.
- **Consequences:** Activity lists a request the moment it opens, with no Refresh, and with
  timings and token counts once the app pins a core with the 2026-10-26 core change; with core
  0.19.0 the row is live and labelled, the numbers stay dashes. The webview now handles two
  inspector events per API request while no Server page is open (the Rust side already emitted
  them); the store stays capped at 500 rows and memory-only. ATO-113 is unchanged: previews are
  collected only while a page watches. The app's own proxy (mobile) still records only while
  watched.
- **Owner:** team
- **Links:** `web-app/src/hooks/useApiServerLogFeed.ts`, `web-app/src/providers/GlobalEventHandler.tsx`,
  `web-app/src/containers/api/ApiRequestInspector.tsx`,
  `src-tauri/src/core/server/request_inspector.rs` (`record_unannounced_core_request`,
  `finish_fields_from_core`), [List unwatched Local API requests in Activity, without previews](2026-10-21-list-unwatched-api-requests-in-activity-without-previews.md)

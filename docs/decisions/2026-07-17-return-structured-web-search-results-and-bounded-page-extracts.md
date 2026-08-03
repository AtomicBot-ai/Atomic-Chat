---
date: 2026-07-17
title: "Return structured web search results and bounded page extracts"
---

# 2026-07-17 — Return structured web search results and bounded page extracts

- **Context:** Rust Agent web search stripped tags from DuckDuckGo HTML, losing
  result URLs and structure, while web fetch applied the same crude conversion
  despite advertising readable page extraction. The model therefore received
  low-signal observations and repeated identical searches until the loop guard
  intervened.
- **Decision:** Parse DuckDuckGo HTML into bounded title, resolved destination
  URL, and snippet records; detect bot-challenge and empty-result pages
  explicitly. Extract fetched pages from `article`, `main`, or `body`, remove
  page chrome, decode entities, support bounded Markdown or text output, and
  cap response bodies before extraction. Keep both tools behind the existing
  SSRF and HTTP-status guards.
- **Consequences:** Agent observations now preserve the links needed for a
  search-then-fetch workflow and report blocked search pages diagnostically
  instead of inviting retries. Extraction remains intentionally lightweight:
  it does not execute JavaScript, authenticate, or claim full browser
  Readability parity.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/tools/web.rs`](src-tauri/src/core/agent/tools/web.rs),
  [`src-tauri/src/core/agent/tools/web_search.rs`](src-tauri/src/core/agent/tools/web_search.rs),
  [`src-tauri/src/core/agent/tools/web_extract.rs`](src-tauri/src/core/agent/tools/web_extract.rs).

---

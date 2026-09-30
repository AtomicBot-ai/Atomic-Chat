---
date: 2026-09-15
title: "List the rest of Hugging Face under the picks, in its trending order, a page at a time"
---

# 2026-09-15 — List the rest of Hugging Face under the picks, in its trending order, a page at a time

- **Context:** Models opened on the curated staff picks and stopped there;
  Hugging Face was reachable only by typing into the search box, and only
  as a ten-row fallback when the catalog had fewer than five hits. Users
  asked where "all the models" were.
- **Decision:** Under the picks, append Hugging Face's own listing of the
  Hub's format — GGUF everywhere, MLX when the format filter is narrowed to
  it on macOS — in the order the sort dropdown names, with Hugging Face's
  trending score as the default. Fifty rows a page, the next page asked for
  a few rows before the end, pages kept across visits for half an hour. The
  list endpoint carries no file sizes, so a row is lightweight until it
  comes on screen; then its card is fetched, two at a time, never twice,
  with the user's Hugging Face token when there is one. A repo the catalog
  already knows is shown from the catalog, sizes included. A size the row
  does not know yet cannot fail the fit filter.
- **Consequences:** Anonymous requests to Hugging Face are rate-limited per
  IP, which is why sizes follow the viewport rather than the page: a page is
  one request, a fast scroll costs what it shows. Hugging Face exposes the
  `Link` header to cross-origin fetches, so the cursor is read from a plain
  fetch, with the Tauri HTTP plugin as the fallback the registries also use.
  The list endpoint returns `lastModified` only when sorting by it; the other
  orders carry the creation date. Pages and cards live in a
  module-level cache, not the persisted catalog. The Hub's own sort dropdown
  now names Hugging Face's orders too. A picked model is listed once, as the
  pick.
- **Owner:** @danyurkin.
- **Links:** [`web-app/src/hooks/useHuggingFaceFeed.ts`](../../web-app/src/hooks/useHuggingFaceFeed.ts),
  [`web-app/src/services/models/default.ts`](../../web-app/src/services/models/default.ts) (`listHuggingFaceFeed`),
  [`web-app/src/routes/hub/index.tsx`](../../web-app/src/routes/hub/index.tsx),
  [2026-08-06 Serve Hub staff picks from a separate manifest and split view](2026-08-06-serve-hub-staff-picks-from-a-separate-manifest-and-split-view.md).

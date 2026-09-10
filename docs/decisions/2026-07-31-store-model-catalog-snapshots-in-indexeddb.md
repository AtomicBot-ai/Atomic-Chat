---
date: 2026-07-31
title: "Store model catalog snapshots in IndexedDB"
---

# 2026-07-31 — Store model catalog snapshots in IndexedDB

- **Context:** The model catalog registry wrote its full catalog and MiniSearch
  snapshot to localStorage. The catalog has always exceeded the 5–10 MiB
  per-origin quota, so writes failed and every app start downloaded and parsed
  the catalog again.
- **Decision:** Persist both snapshots as structured-clone values in a dedicated
  IndexedDB object store. Keep the one-hour TTL, stale-cache fallback, bundled
  seed, and in-memory synchronous store API unchanged.
- **Consequences:** Catalog caching works for production-sized payloads without
  adding a runtime dependency. Cache access becomes asynchronous, and webviews
  where IndexedDB is unavailable degrade to the bundled seed plus network
  refresh.
- **Owner:** team
- **Links:** [ATO-376](https://linear.app/atomicchat/issue/ATO-376/kesh-kataloga-modelej-nikogda-ne-zapisyvaetsya-manifest-ne-vlezaet-v),
  `web-app/src/services/model-catalog-registry.ts`,
  `web-app/src/stores/model-catalog-store.ts`

Supersedes the model-catalog localStorage cache choice in
`2026-05-27-replace-janhq-model-catalog-fuse-js-with-curated-atomicbot-ai.md`.

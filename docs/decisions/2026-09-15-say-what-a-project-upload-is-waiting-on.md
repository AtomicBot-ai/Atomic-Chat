---
date: 2026-09-15
title: "Say what a project file upload is waiting on, and never hide a failed listing"
---

# 2026-09-15 — Say what a project file upload is waiting on, and never hide a failed listing

- **Context:** The Files section of a project showed only a spinner on the
  Upload button while a file was ingested. The first upload in an install
  also downloads the `sentence-transformer-mini` embedding model from
  HuggingFace and starts it, inside the same promise, with no progress and no
  cancel — several minutes of silent spinning that a user reported as the
  upload "looping". Separately, a failed `listAttachmentsForProject` was
  swallowed and rendered the empty state, so a project with files (or a
  just-finished upload) looked empty.
- **Decision:** While an upload runs, render a live status line under the
  header with the embedding-model download and its percentage whenever the
  global download store has an entry for `EMBEDDING_MODEL_ID`; the
  "Indexing…" button label and the dropzone hint from the #289 re-entry fix
  cover the rest of the wait. When the listing fails, render an error state
  with the message and a Retry button instead of the empty state. Read the
  download progress from the existing `useDownloadStore` rather than adding
  a second event subscription.
- **Consequences:** The wait is explained, not removed: the download and
  model load still run inside the ingest promise, and the 30-minute
  model-load readiness ceiling (2026-06-16) still applies. Whether the
  reported hang was this first-use path, the #289 re-entry race, or a
  genuinely stuck load could not be told from the report; the status line
  makes them distinguishable in the next one. Two follow-ups stay open: `ingestFileForProject` embeds every
  chunk twice (vector-db extension, no test harness yet), and `load()` waits
  on `configureBackendsPromise` without the 20 s bound its sibling uses.
- **Owner:** @danyurkin.
- **Links:** [`web-app/src/containers/ProjectFiles.tsx`](../../web-app/src/containers/ProjectFiles.tsx),
  [`web-app/src/hooks/useDownloadStore.ts`](../../web-app/src/hooks/useDownloadStore.ts),
  [`extensions/llamacpp-upstream-extension/src/index.ts`](../../extensions/llamacpp-upstream-extension/src/index.ts) (`embed`),
  [2026-06-16 Raise the model-load readiness timeout to a 30-min floor](2026-06-16-raise-the-model-load-readiness-timeout-to-a-30-min-floor-so.md).

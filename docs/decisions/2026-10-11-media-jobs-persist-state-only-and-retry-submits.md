---
date: 2026-10-11
title: "Media jobs persist state-only history and retry submissions"
---

# 2026-10-11 — Media jobs persist state-only history and retry submissions

- **Context:** Media jobs lived only in the in-memory job manager, so a reload
  lost every record of past generations, and a transient submit failure (rate
  limit, dropped connection) failed the whole job immediately. The built-in
  engine also advertised `features.progress: true` while its job endpoint
  reported only status and queue position.
- **Decision:** Persist job history to `<data_folder>/media/jobs.json` through
  a new `jobsStore.ts` that mirrors `library.ts`'s discipline (atomic
  temp-then-rename writes, coalesced bursts, read-only when the file's
  `schema_version` is newer, corrupt-degrades-to-empty). Save **state and
  provenance only** — `outputs` is stripped before writing, because inline
  base64 is too large to re-serialise every poll and the library already owns
  the materialised files. On load, terminal jobs are restored as history;
  non-terminal jobs become `failed` with `error.code: 'interrupted'` and
  `retryable: true`, since a watcher/backoff/subscription cannot be resumed
  across a reload. Submissions retry up to three attempts with backoff,
  honouring a provider's `retryable` flag and `retryAfterMs`; a provider error
  with no flag defaults to retryable (it is a transport failure, not a job
  verdict). The singleton wires persistence through a lazy dynamic import of
  `@/stores/media-library-store` so importing `jobManager.ts` — and therefore
  the test environment — never loads `@janhq/core`. Set
  `features.progress` to `false` until the engine actually emits progress.
- **Consequences:** History survives restarts and is restored once per
  `useMediaGeneration` mount. A corrupt or newer-schema jobs file never takes
  the Media surface down and is never overwritten. The in-memory store remains
  the source of truth; the disk copy is a best-effort snapshot. Progress stays
  honestly absent until the Rust stdout parser is forwarded to the frontend.
- **Owner:** team
- **Links:** `web-app/src/services/media/jobsStore.ts`,
  `web-app/src/services/media/jobManager.ts`,
  `web-app/src/hooks/useMediaGeneration.ts`,
  `web-app/src/services/media/adapters/builtinEngine.ts`

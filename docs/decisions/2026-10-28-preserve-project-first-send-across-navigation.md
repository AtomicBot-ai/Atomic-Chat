---
date: 2026-10-28
title: "Preserve a project's first queued send across navigation"
---

# 2026-10-28 - Preserve a project's first queued send across navigation

- **Context:** Regression B03 found that a project composer promised to send after the first model download, but navigating away discarded its component-local queue. Only the home composer had a root-owned fallback.
- **Decision:** Queue a project's first text-only send in the same root store. Capture its project, assistant, composer key and approval/workspace state when Send is pressed. The mounted composer claims the entry; unmounting releases it to the background provider. Background retrieval uses the captured project and clears only the originating draft.
- **Consequences:** Visiting New Chat or Settings cannot silently cancel this project send or move it into an unrelated project. The existing single-entry, session-only queue and attachment restrictions remain. Download cancellation still disarms the queue. A send completed in the background reports its start without changing the user's current page.
- **Owner:** team.
- **Links:** `web-app/src/containers/ChatInput.tsx`, `web-app/src/providers/DeferredFirstSendProvider.tsx`, `web-app/src/stores/deferred-first-send-store.ts`.

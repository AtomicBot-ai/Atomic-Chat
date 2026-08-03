---
date: 2026-07-20
title: "Open Agent-referenced files from assistant summaries"
---

# 2026-07-20 — Open Agent-referenced files from assistant summaries

- **Context:** Agent replies commonly report created output as an absolute path
  and refer to staged input attachments by their original filename, but both
  rendered as inert text.
- **Decision:** In Agent assistant messages only, link absolute paths observed
  in tool-call arguments and original filenames from preceding attachment
  parts. Resolve duplicate filenames conservatively, intercept only an
  internal Atomic Chat file-link URL, and open the resolved local path through
  the existing desktop system command. Render absolute references using only
  the filename as the visible link label while retaining the full path as the
  hidden open target.
- **Consequences:** Users can open generated files or referenced attachments
  directly from an Agent summary. Ordinary Chat rendering, code spans, fenced
  code, existing Markdown links, and ambiguous attachment names remain
  unchanged.
- **Owner:** team.
- **Links:** [`web-app/src/lib/agent-file-links.ts`](web-app/src/lib/agent-file-links.ts),
  [`web-app/src/containers/MessageItem.tsx`](web-app/src/containers/MessageItem.tsx),
  [`web-app/src/routes/threads/$threadId.tsx`](web-app/src/routes/threads/$threadId.tsx).

---

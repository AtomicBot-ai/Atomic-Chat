---
date: 2026-09-14
title: "Re-read skill bodies when a skill changes"
---

# 2026-09-14 — Re-read skill bodies when a skill changes

- **Context:** `CustomChatTransport.skillDetailCache` memoized invoked-skill
  bodies for the transport's lifetime — which is the session — and was never
  invalidated. It also cached the *usability verdict*, computed against
  `mcpToolNames`, a set `useTools` fills in asynchronously after boot. So an
  edited `SKILL.md` never reached the model inside an open thread, and a skill
  invoked before the MCP servers finished connecting was written off as
  unusable for the rest of the session.
- **Decision:** cache only the fetch (null = could not be fetched at all) and
  re-decide usability on every send. Add a module-level revision counter
  (`lib/agent-skill-revision.ts`) bumped inside the mutating service calls
  themselves, so no call site can forget it; the transport drops its cache when
  the revision moves.
- **Consequences:** an edit is live on the next message, with no restart and no
  new thread. A deleted skill costs one failed IPC per send until the thread
  moves on, which is bounded by the 6-skill cap. The counter is deliberately
  not a store: `chat-skill-injection.ts` must not pull `@tauri-apps/api` into
  the web build, and skills mutate rarely enough that polling on send is
  enough.
- **Owner:** `team`
- **Links:** `web-app/src/lib/agent-skill-revision.ts`,
  `web-app/src/lib/chat-skill-injection.ts`,
  `web-app/src/lib/custom-chat-transport.ts`.

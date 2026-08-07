---
date: 2026-08-07
title: "Remount streamdown code blocks on content change during streaming"
---

# 2026-08-07 — Remount streamdown code blocks on content change during streaming

- **Context:** During streaming, fenced code blocks (e.g. ```` ```bash ````) were sometimes left showing only the first token/word while the underlying message content already contained the full command. Switching chats and back forced a remount and revealed the complete text, confirming the state was correct but the render was stale. The app renders non-HTML code blocks by delegating a reconstructed fenced string back into a nested `Streamdown` component so that syntax highlighting and mermaid behavior stay consistent.
- **Decision:** Give the nested `Streamdown` a `key` derived from the live code content. When the code content grows during streaming, React unmounts the old nested renderer and mounts a new one, so streamdown's asynchronous Shiki highlighter cannot leave a stale, truncated highlight behind from an earlier chunk.
- **Consequences:** The code block now updates reliably with each streaming chunk. The trade-off is a per-chunk remount, which is acceptable for the small, incomplete code blocks seen while streaming and is cheap once the Shiki token cache is warm. We will keep the outer `RenderMarkdown` / top-level `Streamdown` unkeyed to avoid re-parsing the whole message on every token.
- **Owner:** team
- **Links:** [ATO-413](https://linear.app/atomicchat/issue/ATO-413), `web-app/src/containers/RenderMarkdown.tsx`, `@janhq/streamdown` `CodeBlock` lazy chunk

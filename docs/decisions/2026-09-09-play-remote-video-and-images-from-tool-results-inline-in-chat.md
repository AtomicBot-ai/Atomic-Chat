---
date: 2026-09-09
title: "Play remote video and images from tool results inline in the chat"
---

# 2026-09-09 — Play remote video and images from tool results inline in the chat

- **Context:** Generation connectors (Higgsfield first) return finished work
  as CDN URLs inside text or a typed job record (`{ type: 'video', results:
  { rawUrl, thumbnailUrl } }`, or `jobs_wait`'s `result_url`). The tool card
  showed that as a code block, and the thread bubble rendered image and
  audio file parts but not video. The Tauri content security policy allowed
  `img-src https:` but `media-src` stopped at local/blob/data sources, so a
  remote `<video>` could not play at all. Claude and Codex desktop both play
  such results inline; a bare link kills the demo.
- **Decision:** One extractor, `lib/tool-media.ts`, walks a tool result —
  chat mode's MCP `content` array, agent mode's outcome with its JSON-string
  `content`/`structuredContent` — and returns images and videos it points at:
  any http(s) URL whose path has an image or video extension the webview can
  decode, plus typed generation records regardless of extension, with a
  video's thumbnail used as its poster rather than listed as an image. Capped
  at 12, deduped. `ToolOutput` renders that gallery above the raw result;
  the raw text stays. Assistant prose gets the same treatment for videos
  only (images already come through Markdown). `file` parts with a `video/*`
  media type become a `video` trace block next to the existing image and
  audio ones. `media-src` gains `https:`, matching `img-src`; a failed load
  degrades to the URL as a link. Local files get the same: an agent that
  writes `![preview](porsche-preview.gif)` for a file it just produced used
  to hit rehype-harden's "[Image blocked]" placeholder, because the plugin
  refuses any image source that is not an absolute remote URL, and its
  `[Preview x.mp4](file:///…)` link hit the same plugin's `file:` block.
  Such images, links and bare `file://` URLs are rewritten before rendering
  into `https://atomic.local/media?path=…` links (non-media files become the
  existing `open-file` links) (the same trick as the existing `open-file` links), resolved against
  the message's known files and then the thread's primary workspace root;
  the `a` renderer turns them back into a `<video>` or `<img>` served via
  `convertFileSrc` (the `asset:` protocol, already in the CSP), or an
  open-with-OS link for anything else. The agent persona now says so — the
  model used to append "an inline preview isn't available through my tools"
  under a working player, because nothing had told it the chat renders
  media.
- **Consequences:** Higgsfield renders, and anything else that returns a CDN
  URL, play in the tool card and under the answer with native controls.
  Remote video now loads from any https host the model or a tool names —
  the same exposure `img-src https:` already accepted. No autoplay, metadata
  preload only. The extractor never marks a URL without an extension unless
  a typed record vouches for it, so ordinary links stay links.
- **Owner:** `team`.
- **Links:** `web-app/src/lib/tool-media.ts`,
  `web-app/src/components/ai-elements/tools/tool-media.tsx`,
  `web-app/src/components/ai-elements/tools/tool.tsx`,
  `web-app/src/lib/tools/message-trace-parts.ts`,
  `web-app/src/containers/MessageItem.tsx`, `src-tauri/tauri.conf.json`;
  Higgsfield output schemas in
  `Documents/Marketing/higgsfield-integration/tools-list.json`.

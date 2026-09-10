---
date: 2026-06-10
title: "Render inline image (`file`) parts in the chat thread bubble (ATO-120)"
---

# 2026-06-10 — Render inline image (`file`) parts in the chat thread bubble (ATO-120)

- **Context:** Attaching an image to a chat message (model
 `gemma-4-12B-it-4bit`, a vision model; macOS) did **not** render the image in
 the thread — neither in the user bubble nor in history — yet the model
 received and correctly described it. So the image reached the backend; only
 the **UI render path** was broken. Reproduced with both clipboard paste and
 file upload ([ATO-120](https://linear.app/atomicchat/issue/ATO-120)). Root
 cause: after the AI SDK / `UIMessage.parts` migration, images live as
 `type: 'file'` parts (`mediaType` + data-URL `url`) and are forwarded to the
 model via `convertToModelMessages`
 ([`custom-chat-transport.ts`](web-app/src/lib/custom-chat-transport.ts)), but
 the **display** path never handled them:
 [`buildTraceBlocks`](web-app/src/lib/tools/message-trace-parts.ts) only
 emitted `text` / `reasoning` / `tool-*` blocks and silently dropped `file`
 parts, and [`MessageItem`](web-app/src/containers/MessageItem.tsx) only
 rendered those block kinds (image URLs were extracted **only** to feed the
 Edit dialog's thumbnails — proof the data was present). Net effect: text
 bubble shown, image gone; an image-only message rendered as a blank row. The
 `previewImage` full-screen overlay already existed in `MessageItem` but
 `setPreviewImage` was never called (dead code).
- **Decision:** Implement the missing render path (display-only; no change to
 the model/persistence path, which already round-trips images correctly via
 [`messages.ts`](web-app/src/lib/messages.ts) ↔ `ContentType.Image`). Three
 edits:
 1. New `TraceBlock` variant `{ kind: 'file'; key; url; mediaType; filename? }`
 in [`types.ts`](web-app/src/lib/tools/types.ts).
 2. `buildTraceBlocks` now emits a `file` block for any
 `part.type === 'file'` whose `mediaType` starts with `image/` (preserving
 part order; non-image files are still ignored).
 3. `MessageItem` gains `renderFileBlock` (an `<img>` thumbnail, capped
 `max-h-80`, aligned right for user / left for assistant) wired into the
 block switch, and clicking it now drives the **previously-dead**
 `setPreviewImage` overlay for full-screen preview.
- **Consequences:** Attached images render inline in the thread for both fresh
 sends and reloaded history; image-only messages are no longer blank; the
 full-screen image preview is now reachable. Display-only — no Rust, IPC,
 schema, or persistence change; non-image attachments and the document-chip
 (`[ATTACHED_FILES]`) path are untouched. Images render in natural part order
 (text-then-image for user sends) rather than grouped inside the text bubble —
 acceptable and minimal; grouping into a single bubble was deliberately not
 done. Verified: `tsc -b` clean, `eslint` clean on the three touched files.
 **Not done:** preserving images on message edit (`handleEditMessage` still
 strips to text-only) and the orphan `ImageModal` component remain as-is.
- **Owner:** team.
- **Links:** [ATO-120](https://linear.app/atomicchat/issue/ATO-120), files:
 [`web-app/src/lib/tools/types.ts`](web-app/src/lib/tools/types.ts),
 [`web-app/src/lib/tools/message-trace-parts.ts`](web-app/src/lib/tools/message-trace-parts.ts),
 [`web-app/src/containers/MessageItem.tsx`](web-app/src/containers/MessageItem.tsx).

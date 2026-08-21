---
date: 2026-08-21
title: 'Keep attachments when a message is edited in a chat thread'
---

# 2026-08-21 — Keep attachments when a message is edited in a chat thread

- **Context:** Editing a user message in an ordinary (non-Agent) thread
  destroyed its attached images. `handleEditMessage` rebuilt both the persisted
  `content` array and the UI `parts` array head-first, keeping the non-text
  entries only when `isAgentThread`:
  `content: [Text(newText), ...(isAgentThread ? content.filter(c => c.type !== Text) : [])]`.
  Images live **only** in `content` as `ContentType.Image` data URLs
  (`web-app/src/lib/completion.ts:60-72`), and `updateMessage` overwrites the
  JSONL record wholesale (`src-tauri/src/core/threads/file_store.rs:146-153`),
  so the loss was permanent. Audio and documents were luckier — they live in
  `metadata`, which the non-Agent branch preserved — but they still vanished
  from the live transcript and from what `regenerate` re-sent, until a reload.
  Git archaeology settles the intent: the pre-image at `272b45bb4^` is
  `content: [ { type: ContentType.Text, ... } ]` with no spread at all, and
  `272b45bb4` ("Feature/agent integration", #204) added the `isAgentThread ?`
  arms to keep **its own** flow working across an edit — the Agent re-run reads
  images back out of `content` via `agentAttachmentsFromMessage`. The `else []`
  is inherited Jan-upstream behaviour that nobody chose; no commit message or
  decision record ever argued chat edits should drop attachments. The defect
  became user-visible when editing moved inline (the 2026-08-21 ADR *Edit
  messages inline in the transcript instead of in a modal dialog*): the image
  now sits directly beside the editor and disappears on save.
- **Decision:** Extract the rebuild into two pure helpers in
  [`web-app/src/lib/message-edit.ts`](web-app/src/lib/message-edit.ts) —
  `rebuildEditedContent(content, newText)` and
  `rebuildEditedParts(parts, newText)` — and call them unconditionally from
  `handleEditMessage`. The rule they implement is *an edit replaces the text and
  keeps the attachments*, with two deliberate narrowings that make it
  role-independent and provider-safe:
  1. **`content` keeps `ContentType.Image` only**, not "everything non-text".
     Images are the only attachment type stored there; `Reasoning` and
     `ToolCall` are the model's record of an answer the edit just invalidated,
     and re-appending them head-first would render reasoning *below* the reply
     it supposedly preceded. This also means edited **assistant** messages
     behave exactly as before, so the fix is a pure restoration with no second
     behaviour change riding along.
  2. **`parts` keeps `image/*` and `audio/*` file parts only**, not every
     `file` part. That is precisely the shape a freshly sent message has
     (`processAndSendMessage` builds text + image/audio parts and nothing
     else), so what an edit re-sends matches what the original send did.
     Documents are not lost — they ride in the message text as an
     `[ATTACHED_FILES]` block, which the inline editor re-injects, and in
     `metadata.file_attachments`. The narrowing is a guard, not a fix: no
     document file part exists today (see the same-day ADR *Strip every
     non-image file part before the model converter*), and the point is that
     one appearing later cannot silently turn an edit into a broken request.
  The extraction is the seam: nothing imports `$threadId.tsx` (1931 lines, ~50
  imports incl. Tauri IPC, the extension/engine managers and `useChat`), so the
  logic was untestable in place. It follows the repo's own precedent —
  `web-app/src/lib/agent-route.ts` is a 7-line extraction from this same route
  with a colocated test.
- **Consequences:** No sequencing change was needed. `setChatMessages` is not
  React state — the AI SDK's `setMessages` writes `chatRef.current.messages`
  synchronously and `regenerate` reads that same live array — so restoring the
  parts in `updatedChatMessages` is enough for the re-sent request to carry the
  image. Agent threads are unaffected in two independent ways: editing is
  disabled there (`onEdit={agentModeActive ? undefined : handleEditMessage}`),
  making the old `true` arms dead code, and `agentAttachmentsFromMessage` only
  ever read `ContentType.Image` out of `content` anyway. What stays Agent-only
  is untouched: the `metadata.agent_input_text` ternary and the
  `if (isAgentThread) await handleRegenerate(...)` hand-off. One consequence to
  accept knowingly: an edited message now re-sends its image to whatever model
  is selected, with no vision-capability check — but that is already what a
  first send and a plain regenerate do (gating exists only at *attach* time in
  `ChatInput`), so the edit path merely stops being an accidental escape hatch.
  **Correction to an earlier draft of this record:** it claimed a reloaded
  thread carries documents as `application/pdf` file parts and that any
  follow-up send therefore throws. That is not true of HEAD —
  `metadata.file_attachments` never carries a `mediaType`, so
  `convertThreadMessageToUIMessage` never rebuilds the part. The narrowing in
  point 2 stands as a guard; the send-path half of it is the same-day ADR
  *Strip every non-image file part before the model converter*, which also
  records the live defect that latency uncovered.
  **Verified:** 11 new tests in
  [`message-edit.test.ts`](web-app/src/lib/message-edit.test.ts) — image kept,
  multi-image order kept, audio kept, documents dropped, reasoning/tool entries
  dropped, several text parts collapsed to one, missing arrays tolerated, plus a
  round-trip feeding the rebuilt record back through
  `convertThreadMessageToUIMessage` to prove it is still loadable with the image
  intact. Full web-app suite green: 192 files, 2016 tests.
- **Owner:** team.
- **Links:** the 2026-08-21 ADR *Edit messages inline in the transcript instead
  of in a modal dialog*, the 2026-07-20 ADR *Stage Agent attachments and isolate
  image analysis*, commit `272b45bb4` (Feature/agent integration, #204), files:
  [`web-app/src/lib/message-edit.ts`](web-app/src/lib/message-edit.ts),
  [`web-app/src/routes/threads/$threadId.tsx`](web-app/src/routes/threads/$threadId.tsx)
  (`handleEditMessage`),
  [`web-app/src/lib/completion.ts`](web-app/src/lib/completion.ts)
  (`newUserThreadContent`),
  [`web-app/src/lib/messages.ts`](web-app/src/lib/messages.ts)
  (`convertThreadMessageToUIMessage`).

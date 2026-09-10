---
date: 2026-08-21
title: 'Edit messages inline in the transcript instead of in a modal dialog'
---

# 2026-08-21 — Edit messages inline in the transcript instead of in a modal dialog

- **Context:** User feedback: "when I edit, do *not* blur out the background and
  superimpose it. It would be much better to edit it in-place." The pencil in the
  message action row opened `EditMessageDialog`, a Radix dialog that blurred the
  thread and floated a fixed-height textarea over it — so the message being
  edited was hidden behind the thing editing it, and its surrounding context was
  gone. Every reference app (Claude, ChatGPT) edits where the message sits.
- **Decision:** Replace the dialog with
  [`InlineMessageEditor`](web-app/src/containers/InlineMessageEditor.tsx), mounted
  by [`MessageItem`](web-app/src/containers/MessageItem.tsx) in place of the
  message's text. `EditMessageDialog.tsx` is deleted along with its barrel export
  and its now-orphaned `common:dialogs.editMessage` key in all 14 locales; the
  already-translated but previously dead flat key `common:editMessage` is revived
  for the pencil's label, so no new translation work. Details worth recording:
  - **Keybindings follow the composer, not the old dialog.** Enter saves,
    Shift+Enter inserts a newline, Escape cancels — the dialog used Ctrl+Enter
    and had no Escape branch of its own. The composer's IME guard
    (`isComposing || keyCode === 229`) is carried over, and every keydown is
    `stopPropagation()`'d because the app's global shortcuts listen on `window`
    with no focused-input guard.
  - **A no-op save is routed to cancel.** Saving a *user* message deletes every
    later message in the thread and re-runs the model; with Enter-to-save that is
    one keystroke, so an unchanged draft must not reach `onEdit`.
  - **Editing state is local to `MessageItem`.** Its memo comparator compares
    neither `onEdit` nor any edit prop, so an `editingMessageId` lifted to the
    thread route would go stale for every non-last message.
  - **The `[ATTACHED_FILES]` round-trip is kept** (`extractFilesFromPrompt` on
    open, `injectFilesIntoPrompt` on save) — document attachments are encoded in
    the message text, not as parts.
  - **No "revert edit".** The same report asked for one; it is deliberately out
    of scope. There is no edit history and `modify_message` overwrites the JSONL
    record wholesale, so it would be a storage-format change, not a UI one.
  - The dialog's image-removal thumbnails are **not** ported: `keptImages` only
    gated the Save button and `handleSave` never read it, so removing an image
    did nothing. Attachments render read-only beside the editor.
  - `ChatInput`'s "focus when streaming finishes" effect now skips when another
    input/textarea/contenteditable holds focus, so a stream completing mid-edit
    no longer yanks the caret into the composer.
- **Consequences:** The save path is untouched — `MessageItemProps.onEdit` keeps
  its `(messageId, newText)` contract and `handleEditMessage` in
  `web-app/src/routes/threads/$threadId.tsx` is unchanged, so persistence,
  truncate-and-regenerate for user messages and in-place rewrite for assistant
  messages all behave exactly as before. Editing stays disabled in agent mode.
  Two messages can now be open for edit at once (each `MessageItem` owns its
  flag); that matches the old per-item modal behaviour — making it exclusive
  means lifting the flag *and* adding it to the memo comparator.
  **Adjacent bug this surfaced:** `handleEditMessage` rebuilt `content`/`parts`
  with the non-text entries gated behind `isAgentThread`, so editing a non-agent
  user message destroyed its images. Pre-existing, but inline editing made it
  visible — the image sits right next to the editor and vanished on save. Fixed
  in the same-day ADR *Keep attachments when a message is edited in a chat
  thread*, which extracts the rebuild into `web-app/src/lib/message-edit.ts`;
  `MessageItemProps.onEdit` and its `(messageId, newText)` contract are unchanged
  by that fix.
  **Verified:** 16 new tests (`InlineMessageEditor.test.tsx` covering the
  attachment round-trip, Enter/Shift+Enter/Escape, IME composition, the no-op and
  whitespace guards and shortcut isolation; `MessageItem.inlineEdit.test.tsx`
  covering the in-place swap, action-row hiding, save/cancel wiring and assistant
  messages). Full web-app suite green: 191 files, 2005 tests.
- **Owner:** team.
- **Links:** files:
  [`web-app/src/containers/InlineMessageEditor.tsx`](web-app/src/containers/InlineMessageEditor.tsx),
  [`web-app/src/containers/MessageItem.tsx`](web-app/src/containers/MessageItem.tsx),
  [`web-app/src/containers/ChatInput.tsx`](web-app/src/containers/ChatInput.tsx),
  [`web-app/src/containers/dialogs/index.ts`](web-app/src/containers/dialogs/index.ts),
  `web-app/src/locales/*/common.json`.

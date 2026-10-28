---
date: 2026-10-28
title: "Export a chat as Markdown from its menu"
---

# 2026-10-28 — Export a chat as Markdown from its menu

- **Context:** Users asked to keep a chat outside the app as a file (support email
  of 5 Sep, ATO-504; Discord on 28 Oct, alongside ATO-516). The desktop app had no
  way to save a conversation: only single code blocks could be downloaded.
- **Decision:** The chat row's "…" menu gets "Export as Markdown" on desktop. It reads
  the chat from disk (`messages().fetchMessages`), converts it with the same
  `convertThreadMessagesToUIMessages` the chat view uses, and writes the result of
  `threadToMarkdown` (`web-app/src/lib/thread-markdown.ts`) through the native save
  dialog and `write_file_sync`, as the code-block download does. The document is
  the title, the export time in UTC, then one `## User` / `## Assistant` section
  per message: text as written, reasoning and tool results folded in
  `<details>`, tool inputs as JSON, tool errors as text. Attached files on disk
  are linked; inline image data is named, not embedded; tool results over
  4,000 characters are cut.
- **Consequences:** A chat can be kept, shared or diffed as a plain file. The
  export is one-way: there is no import, and it is not a backup of the chat
  store (that remains ATO-516). Mobile builds do not show the item until a share
  sheet path exists there.
- **Owner:** `team`.
- **Links:** Linear ATO-504, ATO-516; `web-app/src/containers/ThreadList.tsx`,
  `web-app/src/lib/thread-markdown.ts`.

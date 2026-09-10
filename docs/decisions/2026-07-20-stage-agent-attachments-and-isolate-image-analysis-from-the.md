---
date: 2026-07-20
title: "Stage Agent attachments and isolate image analysis from the agent slot"
---

# 2026-07-20 — Stage Agent attachments and isolate image analysis from the agent slot

- **Context:** Agent threads rejected attachments even though ordinary Chat
  already captured local documents and image data. The Rust loop had document
  parsing tools but no bounded attachment IPC contract, no safe read boundary
  outside the selected workspace, and no vision tool. Local llama.cpp sessions
  may also be text-only, so an image cannot be accepted optimistically and
  interpreted later without checking the active session.
  Image files can also carry misleading names (for example JPEG or WebP bytes
  under a `.png` suffix), so requiring the suffix to match the encoded payload
  rejects images that browsers can decode correctly.
- **Decision:** Accept at most eight file/image attachments per Agent turn,
  validate and copy them into
  `<thread>/agent-attachments/<turn>/`, and append a compact manifest containing
  deterministic `attachment://<staged-name>` references instead of absolute
  UUID-heavy paths. Resolve those references only against the turn-scoped
  read-only trusted root while retaining approval gates for writes and deletes
  outside the workspace. Keep documents on `os.fs.read_document`; add bounded
  `vision.describe` requests through `/v1/chat/completions` on the active
  llama.cpp session, separate from the grammar-constrained `/completion` slot.
  For image attachments, treat the PNG/JPEG/GIF/WebP byte signature as
  authoritative, assign the staged file its canonical extension and MIME type,
  and let `vision.describe` detect the payload from those bytes rather than
  rejecting a valid image because of its original suffix.
  Reject image turns before staging when the selected session has no `mmproj`,
  and repeat the capability check inside the vision tool. Audio remains
  unsupported.
- **Consequences:** Agent submit, history, edit-regeneration, and retry retain
  documents, arbitrary local files, and images without persisting base64 or
  original external paths in the Agent session transcript. Models no longer
  need to reproduce long application-data and UUID paths when invoking file
  tools. Text-only models fail before creating a user turn and prompt the user
  to choose a vision-capable model. Staged files consume thread storage until
  that thread is deleted; image analysis is limited to PNG, JPEG, GIF, and
  WebP. Mislabelled supported images remain usable while unknown image
  encodings still fail before inference.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/attachments.rs`](src-tauri/src/core/agent/attachments.rs),
  [`src-tauri/src/core/agent/tools/vision.rs`](src-tauri/src/core/agent/tools/vision.rs),
  [`src-tauri/src/core/agent/path_policy.rs`](src-tauri/src/core/agent/path_policy.rs),
  [`web-app/src/routes/threads/$threadId.tsx`](web-app/src/routes/threads/$threadId.tsx).

---

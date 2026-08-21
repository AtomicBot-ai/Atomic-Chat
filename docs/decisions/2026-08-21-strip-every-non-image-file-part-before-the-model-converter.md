---
date: 2026-08-21
title: 'Strip every non-image file part before the model converter'
---

# 2026-08-21 — Strip every non-image file part before the model converter

- **Context:** `stripAudioFileParts`
  (`web-app/src/lib/custom-chat-transport.ts`) removed `audio/*` file parts
  before `convertToModelMessages`, and its own comment stated the general rule
  it did not enforce: "the OpenAI-compatible converter throws on any non-image
  file part". Verified against this repo's `node_modules`:
  `@ai-sdk/openai-compatible` and `@ai-sdk/xai` throw
  `UnsupportedFunctionalityError` for every `file` part whose mediaType is not
  `image/*`, and `model-factory.ts` routes ~20 provider families through that
  converter — every local backend plus google/gemini, groq, deepseek,
  openrouter, ollama and every custom provider. Anthropic does not throw on
  `application/pdf`, but `convertToModelMessages` passes our `url` through
  verbatim as `data` and `convertToLanguageModelV2DataContent` leaves a
  filesystem path as a bare string, so Anthropic would ship the path itself as
  the document's base64 body — an API 400 instead of a client throw.
  So the invariant is real for every provider: **only `image/*` file parts may
  reach a converter.** It was enforced for exactly one of the two media kinds
  that can produce a violation.
- **Decision:** Generalise the guard rather than add a second special case.
  `stripAudioFileParts` becomes `stripUnsupportedFileParts`, exported for test,
  built on one predicate `isModelSupportedPart` — a part passes unless it is a
  `file` part without an `image/*` mediaType. Non-file parts (text, reasoning,
  tool) are untouched, and messages that need no change are still returned by
  reference. The single call site keeps its position between
  `mapUserInlineAttachments` and `convertToModelMessages`; that ordering is
  load-bearing and now says so in the comment — document *text* is folded into
  the message before the strip, and `extractAudioInputParts` already ran
  against the untouched `options.messages`, so nothing the model needs is lost.
  There is exactly one `convertToModelMessages` call, one `streamText` call and
  one `ChatTransport` implementation in the app, so this one guard covers every
  chat request; Agent turns bypass the SDK entirely over IPC.
- **Consequences:** No behaviour change today. This is a guard, not a repair —
  see the correction below. Every attachment kind keeps its own delivery
  channel: images ride as file parts, audio as `input_audio` injected at the
  MLX fetch layer, documents as text (inline) or through the RAG tools
  (embeddings). A non-image file part therefore never carries information the
  model would otherwise miss; it can only break the request. The cost is that a
  provider feature we might want later — Anthropic's native PDF documents — now
  has to pass through this predicate deliberately instead of by accident. That
  is the right way round: it could never have worked by accident, because the
  `url` is a local path no provider can read.
  **Correction this investigation forced.** The same-day ADR *Keep attachments
  when a message is edited in a chat thread* claimed that a reloaded thread
  carries documents as `application/pdf` file parts and that any follow-up send
  throws. **That is not true of HEAD** and the record has been corrected. The
  chain breaks one step earlier: `convertThreadMessageToUIMessage` rebuilds a
  document part only `if (file?.path && file?.mediaType)`, and
  `metadata.file_attachments[].mediaType` is always `undefined` — its only
  writer is `newUserThreadContent` (`web-app/src/lib/completion.ts`) which reads
  `doc.mimeType`, a field `createDocumentAttachment` does not accept and neither
  of its two call sites sets. Verified empirically by running a document through
  `newUserThreadContent` → `convertThreadMessageToUIMessage`: the reloaded
  message carries a single text part and no file part.
  **The live defect that hides behind it, not fixed here.** Because the part is
  never rebuilt, `extractAgentAttachmentReferences`
  (`web-app/src/lib/agent-file-links.ts`) never sees a user-attached document,
  so its consumer in the thread route records nothing and Agent answers never
  linkify a document *the user* attached — the stated purpose of that
  reconstruction block. Tool-produced paths still linkify through
  `extractAgentToolPaths`, which is why the gap went unnoticed;
  `messages-attachments.test.ts` passes only because its fixture supplies a
  `mediaType` the app never writes. Repairing it means populating the media
  type, which is precisely what turns the latent converter failure live — hence
  this guard landing first.
  **Verified:** 7 new tests in
  [`stripUnsupportedFileParts.test.ts`](web-app/src/lib/__tests__/stripUnsupportedFileParts.test.ts)
  — images kept (data: and https:), audio still dropped, `application/pdf` with
  a filesystem path dropped, a file part with no mediaType dropped, reasoning
  and tool parts untouched, unchanged messages returned by reference with no
  mutation of the input, and a message with no `parts` array tolerated. Full
  web-app suite green.
- **Owner:** team.
- **Links:** the 2026-08-21 ADR *Keep attachments when a message is edited in a
  chat thread*, the 2026-08-21 ADR *Edit messages inline in the transcript
  instead of in a modal dialog*, commit `272b45bb4` (Feature/agent integration,
  #204), files:
  [`web-app/src/lib/custom-chat-transport.ts`](web-app/src/lib/custom-chat-transport.ts)
  (`isModelSupportedPart`, `stripUnsupportedFileParts`, `extractAudioInputParts`,
  `mapUserInlineAttachments`),
  [`web-app/src/lib/messages.ts`](web-app/src/lib/messages.ts)
  (`convertThreadMessageToUIMessage`),
  [`web-app/src/lib/completion.ts`](web-app/src/lib/completion.ts)
  (`newUserThreadContent`),
  [`web-app/src/types/attachment.ts`](web-app/src/types/attachment.ts)
  (`createDocumentAttachment`),
  [`web-app/src/lib/agent-file-links.ts`](web-app/src/lib/agent-file-links.ts).

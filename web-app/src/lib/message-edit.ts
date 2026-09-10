import { ContentType, ThreadContent } from '@janhq/core'
import type { UIMessage } from 'ai'

/**
 * Rebuilding an edited message, kept pure so it can be tested without the
 * thread route (see `handleEditMessage` in
 * `web-app/src/routes/threads/$threadId.tsx`).
 *
 * The rule both helpers implement: **an edit replaces the text and keeps the
 * attachments.** Everything the user attached survives; everything the model
 * generated does not, because the edit replaced the turn it described.
 */

/**
 * Media the app itself puts on a message when it is first sent
 * (`processAndSendMessage` builds text + image/audio parts and nothing else).
 *
 * Document attachments are deliberately excluded. They are not lost — they
 * live in the message text as an `[ATTACHED_FILES]` block and in
 * `metadata.file_attachments`, which the caller preserves. Excluding them is
 * the same rule the send path enforces in `stripUnsupportedFileParts`: only
 * `image/*` file parts may reach a model converter. Today no document file
 * part exists to exclude (`metadata.file_attachments` carries no `mediaType`,
 * so `convertThreadMessageToUIMessage` never rebuilds one), which makes this
 * a guard rather than a fix — deliberately, so that populating that media type
 * cannot silently turn an edit into a broken request.
 */
function isPreservedMediaPart(part: UIMessage['parts'][number]): boolean {
  if (part.type !== 'file') return false
  const mediaType = (part as { mediaType?: string }).mediaType
  return Boolean(
    mediaType?.startsWith('image/') || mediaType?.startsWith('audio/')
  )
}

/**
 * Rebuild the persisted `content` array around new text.
 *
 * Images are the only attachment type that lives in `content` — audio and
 * documents are persisted in `metadata`, which the caller keeps untouched.
 * `reasoning` and `tool_call` entries are dropped: they are the model's record
 * of an answer this edit just invalidated, and re-appending them after the new
 * text would render reasoning below the reply it supposedly preceded.
 */
export function rebuildEditedContent(
  content: ThreadContent[] | undefined,
  newText: string
): ThreadContent[] {
  return [
    {
      type: ContentType.Text,
      text: { value: newText, annotations: [] },
    },
    ...(content ?? []).filter((entry) => entry.type === ContentType.Image),
  ]
}

/**
 * Rebuild the AI SDK `parts` array around new text.
 *
 * The result is the shape a freshly sent message has, so what an edit re-sends
 * matches what the original send did.
 */
export function rebuildEditedParts(
  parts: UIMessage['parts'] | undefined,
  newText: string
): UIMessage['parts'] {
  return [
    { type: 'text' as const, text: newText },
    ...(parts ?? []).filter(isPreservedMediaPart),
  ]
}

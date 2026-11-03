import {
  DOCUMENT_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from '@/containers/chatInput/classifyDroppedPaths'
import {
  classifyWorkspacePreview,
  workspacePreviewMediaType,
} from '@/lib/workspace-preview-kind'

/**
 * How a chat attachment is shown in the preview dialog.
 *
 * - `extracted`: office formats the webview cannot render; the dialog shows
 *   the text the document parser pulls out of them.
 * - `markdown` / `html` / `text`: read from disk and shown as such.
 */
export type AttachmentPreviewKind =
  | 'image'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'markdown'
  | 'html'
  | 'text'
  | 'extracted'
  | 'unsupported'

const EXTRACTED_TEXT_EXTENSIONS = new Set([
  'docx',
  'xlsx',
  'xls',
  'ods',
  'pptx',
])

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])

const HTML_EXTENSIONS = new Set(['html', 'htm'])

/**
 * The extension that decides the preview: the parsed `fileType` when the
 * attachment has one, the file name's otherwise.
 */
export const attachmentPreviewExtension = (
  name: string,
  fileType?: string
): string => {
  if (fileType) return fileType.toLowerCase()
  const base = name.split(/[\\/]/).pop() ?? ''
  if (!base.includes('.')) return ''
  return (base.split('.').pop() ?? '').toLowerCase()
}

export function classifyAttachmentPreview(
  name: string,
  fileType?: string,
  mimeType?: string
): AttachmentPreviewKind {
  if (mimeType?.startsWith('image/')) return 'image'
  if (mimeType?.startsWith('audio/')) return 'audio'
  if (mimeType?.startsWith('video/')) return 'video'

  const ext = attachmentPreviewExtension(name, fileType)
  if (!ext) return 'unsupported'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (EXTRACTED_TEXT_EXTENSIONS.has(ext)) return 'extracted'
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown'
  if (HTML_EXTENSIONS.has(ext)) return 'html'

  const workspaceKind = classifyWorkspacePreview(`attachment.${ext}`)
  if (workspaceKind !== 'unsupported') return workspaceKind
  // Every other document the composer accepts is source code or plain text.
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'text'
  return 'unsupported'
}

/** MIME type of an audio or video attachment, for the media element. */
export const attachmentPreviewMediaType = (
  name: string,
  fileType?: string,
  mimeType?: string
): string | undefined =>
  mimeType ??
  workspacePreviewMediaType(
    `attachment.${attachmentPreviewExtension(name, fileType)}`
  )

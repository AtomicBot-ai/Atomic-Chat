import { readFileBytes } from '@/lib/readFileBytes'
import { Attachment, createImageAttachment } from '@/types/attachment'

const mimeTypeFromExtension = (name: string): string => {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    default:
      return ''
  }
}

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') {
        resolve(result)
      } else {
        reject(new Error('FileReader did not return a string'))
      }
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'))
    reader.readAsDataURL(blob)
  })

export type ReadAttachmentOptions = {
  /**
   * Raw file-size ceiling. Rejects with `FileTooLargeError` before any bytes
   * are read, so the caller can report "too large" instead of a read failure.
   */
  maxBytes: number
}

/**
 * Read an image file by its filesystem path (Tauri only) and produce an
 * Attachment compatible with the existing image ingestion pipeline.
 *
 * Reads through the `read_file_chunk` IPC command in pages rather than
 * `fetch(convertFileSrc(path))`: WebView2 cannot deliver a large asset-protocol
 * body, so anything past ~10 MB failed with "Failed to fetch" (#261).
 */
export const readImageAttachmentFromPath = async (
  path: string,
  { maxBytes }: ReadAttachmentOptions
): Promise<Attachment> => {
  const name = path.split(/[\\/]/).pop() || path
  const mimeType = mimeTypeFromExtension(name)

  const { bytes, size } = await readFileBytes(path, { maxBytes })
  const dataUrl = await blobToDataUrl(new Blob([bytes], { type: mimeType }))
  const base64 = dataUrl.split(',')[1] ?? ''

  return createImageAttachment({
    name,
    base64,
    dataUrl,
    mimeType,
    size,
  })
}

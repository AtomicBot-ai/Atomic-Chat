/**
 * Read the last frame of a stored video as a JPEG data URL, for "Continue this
 * video".
 *
 * The glue between the pure frame extractor (`services/media/videoFrames.ts`)
 * and the filesystem: it reads the file in pages through `readFileBytes` (the
 * asset protocol cannot deliver large bodies on WebView2, #261), wraps the
 * bytes in a blob URL so the canvas is never tainted, and revokes it when done.
 */

import { readFileBytes } from '@/lib/readFileBytes'
import { extractVideoFrames } from '@/services/media/videoFrames'

/**
 * One GiB. "Continue" reads the whole file into memory because an mp4's moov
 * box - required to seek - often lives at the end. Videos past this are
 * declined rather than silently exhausting memory.
 */
export const MAX_CONTINUE_VIDEO_BYTES = 1024 * 1024 * 1024

export async function extractLastFrameDataUrl(
  path: string,
  mime: string
): Promise<string> {
  const { bytes } = await readFileBytes(path, {
    maxBytes: MAX_CONTINUE_VIDEO_BYTES,
  })

  // Copied into a fresh ArrayBuffer: a Uint8Array may be backed by a
  // SharedArrayBuffer, which is not a valid BlobPart.
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const url = URL.createObjectURL(new Blob([buffer], { type: mime }))
  try {
    const frames = await extractVideoFrames(url)
    const frame = frames[0]
    if (!frame) throw new Error('No frame could be extracted from the video.')
    return frame.dataUrl
  } finally {
    URL.revokeObjectURL(url)
  }
}

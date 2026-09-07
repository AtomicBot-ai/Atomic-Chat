import { readFileBytes } from '@/lib/readFileBytes'
import { Attachment, createAudioAttachment } from '@/types/attachment'

import type { ReadAttachmentOptions } from './imageFromPath'

/**
 * Map a filename extension to an audio MIME type. Restricted to mp3/wav — the
 * formats the omni backend accepts AND that the WebKit preview can play.
 */
export const audioMimeTypeFromExtension = (name: string): string => {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg'
    case 'wav':
      return 'audio/wav'
    default:
      return ''
  }
}

/**
 * Read the duration (seconds) of an audio source by loading its metadata.
 * Resolves 0 if the duration can't be determined (so callers never block on it).
 */
export const getAudioDurationSeconds = (src: string): Promise<number> =>
  new Promise((resolve) => {
    try {
      const audio = new Audio()
      audio.preload = 'metadata'
      const cleanup = () => {
        audio.removeEventListener('loadedmetadata', onLoaded)
        audio.removeEventListener('error', onError)
      }
      const onLoaded = () => {
        const d = audio.duration
        cleanup()
        resolve(Number.isFinite(d) ? d : 0)
      }
      const onError = () => {
        cleanup()
        resolve(0)
      }
      audio.addEventListener('loadedmetadata', onLoaded)
      audio.addEventListener('error', onError)
      audio.src = src
    } catch {
      resolve(0)
    }
  })

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

/**
 * Read an audio file by its filesystem path (Tauri only) and produce an
 * Attachment compatible with the chat attachment pipeline.
 *
 * Mirrors `readImageAttachmentFromPath`: pages the file in through the
 * `read_file_chunk` IPC command (the asset protocol cannot deliver a large
 * body on WebView2, #261), then reads the blob as a data URL so the base64
 * payload can be forwarded to the model as `input_audio`.
 */
export const readAudioAttachmentFromPath = async (
  path: string,
  { maxBytes }: ReadAttachmentOptions
): Promise<Attachment> => {
  const name = path.split(/[\\/]/).pop() || path
  const mimeType = audioMimeTypeFromExtension(name)

  const { bytes, size } = await readFileBytes(path, { maxBytes })
  const dataUrl = await blobToDataUrl(new Blob([bytes], { type: mimeType }))
  const base64 = dataUrl.split(',')[1] ?? ''

  return createAudioAttachment({
    name,
    base64,
    dataUrl,
    mimeType,
    size,
  })
}

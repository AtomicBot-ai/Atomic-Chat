/**
 * Unified attachment type for images, audio, video and documents
 */
export type Attachment = {
  name: string
  type: 'image' | 'document' | 'audio' | 'video'

  // Common fields
  size?: number
  chunkCount?: number
  processing?: boolean
  processed?: boolean
  error?: string

  // For images (before upload)
  base64?: string
  dataUrl?: string
  mimeType?: string
  contentHash?: string // Used for deduplication (different files can have same name)

  // For documents and video (local files)
  path?: string
  fileType?: string // e.g., 'pdf', 'docx'
  parseMode?: 'auto' | 'inline' | 'embeddings' | 'prompt'

  // After processing (images uploaded, documents ingested)
  id?: string
  injectionMode?: 'inline' | 'embeddings'
  inlineContent?: string
}

/**
 * Helper to create image attachment
 */
export function createImageAttachment(data: {
  name: string
  base64: string
  dataUrl: string
  mimeType: string
  size: number
}): Attachment {
  return {
    ...data,
    type: 'image',
  }
}

/**
 * Helper to create audio attachment.
 *
 * Audio reuses the same in-memory carrier as images (base64 + dataUrl +
 * mimeType) so the existing attachment chip/dedup machinery works unchanged.
 * Unlike images, audio is never downscaled/transcoded and is delivered to the
 * model as an `input_audio` content part (see model-factory's MLX fetch), not
 * as an `image_url` file part.
 */
export function createAudioAttachment(data: {
  name: string
  base64: string
  dataUrl: string
  mimeType: string
  size: number
}): Attachment {
  return {
    ...data,
    type: 'audio',
  }
}

/**
 * Helper to create video attachment.
 *
 * Video stays on disk and is referenced by path, like a document, but it is
 * never parsed or indexed: no chat model takes video input, so the model is
 * only told that a clip was attached (see `newUserThreadContent`).
 */
export function createVideoAttachment(data: {
  name: string
  path: string
  fileType?: string
  mimeType?: string
  size?: number
}): Attachment {
  return {
    ...data,
    type: 'video',
  }
}

/**
 * Helper to create document attachment
 */
export function createDocumentAttachment(data: {
  name: string
  path: string
  fileType?: string
  size?: number
  parseMode?: 'auto' | 'inline' | 'embeddings' | 'prompt'
}): Attachment {
  return {
    ...data,
    type: 'document',
  }
}

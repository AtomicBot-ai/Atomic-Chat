/**
 * The poster of a clip: its first frame, rendered by the webview and sent to
 * the core, which cannot decode video itself (it takes no media dependency).
 *
 * A detached `<video>` loads the clip over the asset protocol, seeks to the
 * wanted time and is drawn onto a canvas at thumbnail size. The asset
 * protocol answers with CORS headers, so `crossOrigin="anonymous"` keeps the
 * canvas clean; should a build ever taint it, the bytes are read through
 * the paged file command into a same-origin blob URL and drawn from there.
 */

import { convertFileSrc } from '@tauri-apps/api/core'

import { readFileBytes } from '@/lib/readFileBytes'
import type { GalleryVideoItem } from '@/services/diffusion/types'

/** The longer side of a poster, in pixels. Matches the image thumbnails. */
export const POSTER_EDGE = 256
/** The largest clip the blob-URL fallback will read into memory. */
export const MAX_POSTER_SOURCE_BYTES = 256 * 1024 * 1024
/** How long a clip may take to yield a frame before the capture is abandoned. */
export const POSTER_CAPTURE_TIMEOUT_MS = 10_000

export type PosterCaptureReason = 'load' | 'security' | 'timeout' | 'canvas'

export class PosterCaptureError extends Error {
  constructor(
    public readonly reason: PosterCaptureReason,
    message: string
  ) {
    super(message)
    this.name = 'PosterCaptureError'
  }
}

export type CapturePosterOptions = {
  /** Longer side of the result, in pixels. */
  edge?: number
  /** The time to capture at; 0 is the first frame. */
  atSeconds?: number
  timeoutMs?: number
}

/** The poster's size: `edge` on the longer side, at least one pixel on the other. */
export function posterSize(
  width: number,
  height: number,
  edge = POSTER_EDGE
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: edge, height: edge }
  const scale = edge / Math.max(width, height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

const isSecurityError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { name?: unknown }).name === 'SecurityError'

/**
 * Render one frame of the clip at `src` as a PNG, returned as base64 without
 * the data-URL prefix (what the core's poster route takes).
 */
export function capturePosterPng(
  src: string,
  {
    edge = POSTER_EDGE,
    atSeconds = 0,
    timeoutMs = POSTER_CAPTURE_TIMEOUT_MS,
  }: CapturePosterOptions = {}
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const video = document.createElement('video')
    let settled = false
    const timer = setTimeout(
      () =>
        fail(
          new PosterCaptureError('timeout', 'The clip did not yield a frame in time.')
        ),
      timeoutMs
    )

    const cleanup = () => {
      clearTimeout(timer)
      video.removeAttribute('src')
      video.load()
    }
    const fail = (error: PosterCaptureError) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const draw = () => {
      if (settled) return
      try {
        const size = posterSize(video.videoWidth, video.videoHeight, edge)
        const canvas = document.createElement('canvas')
        canvas.width = size.width
        canvas.height = size.height
        const context = canvas.getContext('2d')
        if (!context) {
          throw new PosterCaptureError('canvas', 'Canvas 2D is not available.')
        }
        context.drawImage(video, 0, 0, size.width, size.height)
        const url = canvas.toDataURL('image/png')
        settled = true
        cleanup()
        resolve(url.slice(url.indexOf(',') + 1))
      } catch (error) {
        if (error instanceof PosterCaptureError) fail(error)
        else if (isSecurityError(error)) {
          fail(
            new PosterCaptureError(
              'security',
              'The clip was served cross-origin; the canvas is tainted.'
            )
          )
        } else {
          fail(
            new PosterCaptureError(
              'canvas',
              error instanceof Error ? error.message : String(error)
            )
          )
        }
      }
    }

    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    video.addEventListener('error', () =>
      fail(new PosterCaptureError('load', 'The clip could not be decoded.'))
    )
    video.addEventListener(
      'loadeddata',
      () => {
        if (atSeconds > 0 && video.currentTime !== atSeconds) {
          video.addEventListener('seeked', draw, { once: true })
          video.currentTime = atSeconds
        } else {
          draw()
        }
      },
      { once: true }
    )
    video.src = src
  })
}

/**
 * The poster of a gallery clip: over the asset protocol first, and through a
 * same-origin blob of the file if that tainted the canvas.
 */
export async function capturePosterForClip(
  path: string,
  options: CapturePosterOptions = {}
): Promise<string> {
  try {
    return await capturePosterPng(convertFileSrc(path), options)
  } catch (error) {
    if (!(error instanceof PosterCaptureError) || error.reason !== 'security') {
      throw error
    }
  }
  const { bytes } = await readFileBytes(path, {
    maxBytes: MAX_POSTER_SOURCE_BYTES,
  })
  const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }))
  try {
    return await capturePosterPng(url, options)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export type PosterBackfillOptions = {
  /** Capture and upload the poster of one clip. A rejection marks the clip failed. */
  run: (item: GalleryVideoItem) => Promise<void>
  /** Clips rendered at once. Two keeps a scroll through an old gallery responsive. */
  concurrency?: number
}

/**
 * Posters for clips that have none — made by an outside client through
 * `/v1/videos`, or by a build before posters existed — rendered as their
 * tiles come into view. A clip whose capture failed is not retried in this
 * session: the file is what it is.
 */
export class PosterBackfillQueue {
  private readonly queue: GalleryVideoItem[] = []
  private readonly queued = new Set<string>()
  private readonly running = new Set<string>()
  private readonly failed = new Set<string>()
  private readonly concurrency: number
  private readonly run: PosterBackfillOptions['run']

  constructor({ run, concurrency = 2 }: PosterBackfillOptions) {
    this.run = run
    this.concurrency = Math.max(1, concurrency)
  }

  /** Whether the clip needs a poster this queue would make. */
  wants(item: GalleryVideoItem): boolean {
    return (
      item.posterPath === null &&
      !this.failed.has(item.id) &&
      !this.queued.has(item.id) &&
      !this.running.has(item.id)
    )
  }

  hasFailed(id: string): boolean {
    return this.failed.has(id)
  }

  request(item: GalleryVideoItem): void {
    if (!this.wants(item)) return
    this.queue.push(item)
    this.queued.add(item.id)
    this.pump()
  }

  /** Forget everything, e.g. when the gallery is reset. */
  clear(): void {
    this.queue.length = 0
    this.queued.clear()
    this.failed.clear()
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift()!
      this.queued.delete(item.id)
      this.running.add(item.id)
      void this.run(item)
        .catch((error) => {
          this.failed.add(item.id)
          console.warn(`[videos] poster for ${item.id} not made:`, error)
        })
        .finally(() => {
          this.running.delete(item.id)
          this.pump()
        })
    }
  }
}

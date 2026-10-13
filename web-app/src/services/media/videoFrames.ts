/**
 * Frame extraction from a local video, for "continue from the last frame".
 *
 * Browser-only: a detached `<video>` plus a `<canvas>` capture, the same
 * primitive `assets.ts` uses for thumbnails, so no new dependency. The module
 * takes a URL string (a blob URL or `convertFileSrc` result) rather than a
 * path, which keeps it testable without Tauri and lets the caller own the
 * bytes' lifetime.
 *
 * Only the last frame is captured here; it is the single conditioning image
 * every adapted video model accepts. A 1 fps "reference strip" was considered
 * and declined: models condition on 0-2 frames (first, or first+last), not on
 * an arbitrary sequence, so a strip would be rejected or collapsed into a
 * collage. See the video-continuation ADR.
 */

export type VideoFrame = {
  /** JPEG data URL, suitable for the engine's `init_image` / `end_image`. */
  dataUrl: string
  width: number
  height: number
  /** Seconds into the video this frame came from. */
  atSeconds: number
}

/** How far back from the end to seek, so a keyframe actually exists there. */
export const LAST_FRAME_BACKOFF_SECONDS = 0.1

/** The time to seek to for "the last frame" of a video of `duration` seconds. */
export function lastFrameTime(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.max(0, duration - LAST_FRAME_BACKOFF_SECONDS)
}

/** Longest-edge clamp factor, mirroring the thumbnailer's downscale. */
export function frameScaleToFit(
  width: number,
  height: number,
  maxEdge?: number
): number {
  if (!maxEdge || maxEdge <= 0) return 1
  return Math.min(1, maxEdge / Math.max(width, height))
}

export type ExtractVideoFramesOptions = {
  /** Times in seconds to capture. Defaults to the last frame. */
  at?: number[]
  /** Longest edge to clamp the capture to. Omit for source resolution. */
  maxEdge?: number
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
    }
    const onSeeked = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('The video could not be decoded.'))
    }
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('error', onError)
    video.currentTime = time
  })
}

function captureFrame(
  video: HTMLVideoElement,
  atSeconds: number,
  maxEdge?: number
): VideoFrame | undefined {
  if (video.videoWidth === 0 || video.videoHeight === 0) return undefined
  const scale = frameScaleToFit(video.videoWidth, video.videoHeight, maxEdge)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) return undefined
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.95),
    width: canvas.width,
    height: canvas.height,
    atSeconds,
  }
}

/**
 * Capture frame(s) from a video at `src`. Defaults to the last frame at source
 * resolution. Order matches `options.at`; frames that fail to decode are
 * skipped rather than failing the whole call, so a partial capture still
 * returns what it can.
 */
export async function extractVideoFrames(
  src: string,
  options: ExtractVideoFramesOptions = {}
): Promise<VideoFrame[]> {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.src = src

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('The video could not be decoded.'))
    })

    const duration = Number.isFinite(video.duration)
      ? video.duration
      : 0
    const times =
      options.at && options.at.length > 0
        ? options.at
        : [lastFrameTime(duration)]

    const frames: VideoFrame[] = []
    for (const time of times) {
      const clamped = Math.max(0, Math.min(time, Math.max(0, duration)))
      try {
        await seekTo(video, clamped)
      } catch {
        continue
      }
      const frame = captureFrame(video, clamped, options.maxEdge)
      if (frame) frames.push(frame)
    }
    return frames
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

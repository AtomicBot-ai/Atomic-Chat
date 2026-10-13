/**
 * Frame extraction tests.
 *
 * jsdom cannot decode video and implements neither `HTMLCanvasElement.toBlob`
 * nor a real 2d context, so the happy path is exercised through fakes that
 * stand in for a detached `<video>` and `<canvas>` - the same reason the
 * thumbnailer's canvas path is only run in the real app (recorded against
 * T08-S05). The pure helpers (`lastFrameTime`, `frameScaleToFit`) and the
 * decoder-failure/guard path are tested directly.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  extractVideoFrames,
  frameScaleToFit,
  lastFrameTime,
  LAST_FRAME_BACKOFF_SECONDS,
} from '../videoFrames'

// --- fakes -------------------------------------------------------------------

/** A detached `<video>` stand-in supporting both property and event handlers. */
function fakeVideo({
  emitOnSrc = 'loadedmetadata',
}: { emitOnSrc?: 'loadedmetadata' | 'error' } = {}) {
  const listeners = new Map<string, Set<() => void>>()
  const handlers: Record<string, (() => void) | undefined> = {}
  let currentTime = 0

  const video = {
    duration: 10,
    videoWidth: 1920,
    videoHeight: 1080,
    muted: false,
    preload: '',
    removeAttribute: vi.fn(),
    load: vi.fn(),
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn)
    },
    get onloadedmetadata() {
      return handlers.onloadedmetadata
    },
    set onloadedmetadata(fn: (() => void) | undefined) {
      handlers.onloadedmetadata = fn
    },
    get onerror() {
      return handlers.onerror
    },
    set onerror(fn: (() => void) | undefined) {
      handlers.onerror = fn
    },
    emit(type: string) {
      handlers[`on${type}`]?.()
      listeners.get(type)?.forEach((fn) => fn())
    },
  }

  Object.defineProperty(video, 'src', {
    get: () => '',
    set: () => {
      queueMicrotask(() => video.emit(emitOnSrc))
    },
  })
  Object.defineProperty(video, 'currentTime', {
    get: () => currentTime,
    set: (value: number) => {
      currentTime = value
      queueMicrotask(() => video.emit('seeked'))
    },
  })

  return video
}

function fakeCanvas(hasContext: boolean) {
  return {
    width: 0,
    height: 0,
    getContext: () => (hasContext ? { drawImage: vi.fn() } : null),
    toDataURL: () => 'data:image/jpeg;base64,AAAA',
  } as unknown as HTMLCanvasElement
}

function stubElements(video: ReturnType<typeof fakeVideo>, hasContext = true) {
  return vi
    .spyOn(document, 'createElement')
    .mockImplementation((tag: string) => {
      if (tag === 'video') return video as unknown as HTMLVideoElement
      if (tag === 'canvas') return fakeCanvas(hasContext)
      throw new Error(`Unexpected element ${tag}`)
    })
}

afterEach(() => {
  vi.restoreAllMocks()
})

// --- pure helpers ------------------------------------------------------------

describe('lastFrameTime', () => {
  it('seeks just before the end so a keyframe exists there', () => {
    expect(lastFrameTime(10)).toBe(10 - LAST_FRAME_BACKOFF_SECONDS)
  })

  it('clamps non-positive and non-finite durations to zero', () => {
    expect(lastFrameTime(0)).toBe(0)
    expect(lastFrameTime(-3)).toBe(0)
    expect(lastFrameTime(Number.NaN)).toBe(0)
    expect(lastFrameTime(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('frameScaleToFit', () => {
  it('keeps source resolution when no max edge is given', () => {
    expect(frameScaleToFit(1920, 1080)).toBe(1)
    expect(frameScaleToFit(1920, 1080, 0)).toBe(1)
  })

  it('scales by the longest edge', () => {
    expect(frameScaleToFit(1920, 1080, 960)).toBe(0.5)
  })
})

// --- extraction --------------------------------------------------------------

describe('extractVideoFrames', () => {
  it('captures the last frame at source resolution by default', async () => {
    const video = fakeVideo()
    stubElements(video)

    const frames = await extractVideoFrames('blob:fake')

    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      dataUrl: 'data:image/jpeg;base64,AAAA',
      width: 1920,
      height: 1080,
      atSeconds: 10 - LAST_FRAME_BACKOFF_SECONDS,
    })
    expect(video.load).toHaveBeenCalled()
  })

  it('clamps requested times into the video', async () => {
    const video = fakeVideo()
    stubElements(video)

    const frames = await extractVideoFrames('blob:fake', {
      at: [-1, 100],
    })

    expect(frames.map((frame) => frame.atSeconds)).toEqual([0, 10])
  })

  it('skips frames with no canvas context rather than failing', async () => {
    const video = fakeVideo()
    stubElements(video, false)

    const frames = await extractVideoFrames('blob:fake')

    expect(frames).toEqual([])
  })

  it('rejects when the video cannot be decoded', async () => {
    const video = fakeVideo({ emitOnSrc: 'error' })
    stubElements(video)

    await expect(extractVideoFrames('blob:fake')).rejects.toThrow(
      'The video could not be decoded.'
    )
  })
})

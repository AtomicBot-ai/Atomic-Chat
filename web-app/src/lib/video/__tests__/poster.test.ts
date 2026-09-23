import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeVideoItem } from '@/lib/diffusion/__tests__/video-fixtures'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}))
const files = vi.hoisted(() => ({
  readFileBytes: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), size: 3 })),
}))
vi.mock('@/lib/readFileBytes', () => ({ readFileBytes: files.readFileBytes }))

import {
  capturePosterForClip,
  capturePosterPng,
  MAX_POSTER_SOURCE_BYTES,
  POSTER_EDGE,
  PosterBackfillQueue,
  PosterCaptureError,
  posterSize,
} from '../poster'

/** What the next `<video>` will do: decode (with a size) or fail. */
const video = vi.hoisted(() => ({
  width: 768,
  height: 512,
  mode: 'ok' as 'ok' | 'fail' | 'hang',
  taints: false,
  created: [] as HTMLVideoElement[],
}))

/** jsdom has no object URLs; give the tests a pair to spy on. */
const ensureObjectUrls = () => {
  const url = URL as unknown as Record<string, unknown>
  if (typeof url.createObjectURL !== 'function') url.createObjectURL = () => 'blob:stub'
  if (typeof url.revokeObjectURL !== 'function') url.revokeObjectURL = () => {}
}

describe('posterSize', () => {
  it('puts the longer side at the edge and keeps the shape', () => {
    expect(posterSize(768, 512)).toEqual({ width: 256, height: 171 })
    expect(posterSize(704, 1216)).toEqual({ width: 148, height: 256 })
    expect(posterSize(1, 1000, 100)).toEqual({ width: 1, height: 100 })
    expect(posterSize(0, 0)).toEqual({ width: POSTER_EDGE, height: POSTER_EDGE })
  })
})

describe('capturePosterPng', () => {
  const drawImage = vi.fn()
  const originalCreate = document.createElement.bind(document)

  beforeEach(() => {
    vi.useFakeTimers()
    video.mode = 'ok'
    video.taints = false
    video.created = []
    drawImage.mockClear()
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = originalCreate(tag)
      if (tag === 'video') {
        const media = element as HTMLVideoElement
        Object.defineProperty(media, 'videoWidth', { get: () => video.width })
        Object.defineProperty(media, 'videoHeight', { get: () => video.height })
        media.load = vi.fn()
        // Setting `src` starts the "decode": one macrotask later the clip
        // has a frame, or it errors.
        Object.defineProperty(media, 'src', {
          set: () => {
            if (video.mode === 'hang') return
            setTimeout(() => {
              media.dispatchEvent(new Event(video.mode === 'fail' ? 'error' : 'loadeddata'))
            }, 1)
          },
          get: () => '',
        })
        video.created.push(media)
      }
      if (tag === 'canvas') {
        const canvas = element as HTMLCanvasElement
        canvas.getContext = vi.fn(() => ({ drawImage })) as unknown as HTMLCanvasElement['getContext']
        canvas.toDataURL = vi.fn(() => {
          if (video.taints) {
            const error = new Error('tainted')
            error.name = 'SecurityError'
            throw error
          }
          return 'data:image/png;base64,iVBORw0KGgo='
        })
      }
      return element
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('draws the first frame at thumbnail size and answers bare base64', async () => {
    const pending = capturePosterPng('asset://clip.webm')
    await vi.advanceTimersByTimeAsync(5)
    await expect(pending).resolves.toBe('iVBORw0KGgo=')
    expect(drawImage).toHaveBeenCalledWith(video.created[0], 0, 0, 256, 171)
    expect(video.created[0].muted).toBe(true)
    expect(video.created[0].crossOrigin).toBe('anonymous')
    expect(video.created[0].load).toHaveBeenCalled()
  })

  it('seeks when a later moment is wanted', async () => {
    const pending = capturePosterPng('asset://clip.webm', { atSeconds: 1.5, edge: 64 })
    await vi.advanceTimersByTimeAsync(5)
    const media = video.created[0]
    expect(media.currentTime).toBe(1.5)
    media.dispatchEvent(new Event('seeked'))
    await expect(pending).resolves.toBe('iVBORw0KGgo=')
    expect(drawImage).toHaveBeenCalledWith(media, 0, 0, 64, 43)
  })

  it('names a clip that will not decode, a tainted canvas and a clip that takes too long', async () => {
    video.mode = 'fail'
    const load = expect(capturePosterPng('asset://clip.webm')).rejects.toMatchObject({
      name: 'PosterCaptureError',
      reason: 'load',
    })
    await vi.advanceTimersByTimeAsync(5)
    await load

    video.mode = 'ok'
    video.taints = true
    const taint = expect(capturePosterPng('asset://clip.webm')).rejects.toMatchObject({
      reason: 'security',
    })
    await vi.advanceTimersByTimeAsync(5)
    await taint

    video.taints = false
    video.mode = 'hang'
    const slow = expect(
      capturePosterPng('asset://clip.webm', { timeoutMs: 50 })
    ).rejects.toMatchObject({ reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(60)
    await slow
    expect(video.created.at(-1)!.load).toHaveBeenCalled()
  })

  it('reports a missing canvas context', async () => {
    const pending = expect(capturePosterPng('asset://clip.webm')).rejects.toMatchObject({
      reason: 'canvas',
    })
    vi.mocked(document.createElement).mockImplementationOnce((tag: string) => {
      const canvas = originalCreate(tag) as HTMLCanvasElement
      canvas.getContext = vi.fn(() => null) as unknown as HTMLCanvasElement['getContext']
      return canvas
    })
    await vi.advanceTimersByTimeAsync(5)
    await pending
  })
})

describe('capturePosterForClip', () => {
  beforeEach(() => {
    ensureObjectUrls()
    files.readFileBytes.mockClear()
  })

  it('goes through the asset protocol, and never reads the bytes when the canvas stays clean', async () => {
    const originalCreate = document.createElement.bind(document)
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = originalCreate(tag)
      if (tag === 'video') {
        const media = element as HTMLVideoElement
        media.load = vi.fn()
        Object.defineProperty(media, 'src', {
          set: () => queueMicrotask(() => media.dispatchEvent(new Event('loadeddata'))),
          get: () => '',
        })
      }
      if (tag === 'canvas') {
        const canvas = element as HTMLCanvasElement
        canvas.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as unknown as HTMLCanvasElement['getContext']
        canvas.toDataURL = vi.fn(() => 'data:image/png;base64,QUJD')
      }
      return element
    })
    await expect(capturePosterForClip('/data/videos/a.webm')).resolves.toBe('QUJD')
    expect(files.readFileBytes).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('reads the bytes into a blob URL after a tainted canvas, and gives up on any other failure', async () => {
    const originalCreate = document.createElement.bind(document)
    let attempt = 0
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:clip')
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = originalCreate(tag)
      if (tag === 'video') {
        const media = element as HTMLVideoElement
        media.load = vi.fn()
        Object.defineProperty(media, 'src', {
          set: () => queueMicrotask(() => media.dispatchEvent(new Event('loadeddata'))),
          get: () => '',
        })
      }
      if (tag === 'canvas') {
        const canvas = element as HTMLCanvasElement
        canvas.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as unknown as HTMLCanvasElement['getContext']
        canvas.toDataURL = vi.fn(() => {
          attempt += 1
          if (attempt === 1) {
            const error = new Error('tainted')
            error.name = 'SecurityError'
            throw error
          }
          return 'data:image/png;base64,QUJD'
        })
      }
      return element
    })
    await expect(capturePosterForClip('/data/videos/a.webm')).resolves.toBe('QUJD')
    expect(files.readFileBytes).toHaveBeenCalledWith('/data/videos/a.webm', {
      maxBytes: MAX_POSTER_SOURCE_BYTES,
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith('blob:clip')

    // A decode failure is final.
    spy.mockImplementation((tag: string) => {
      const element = originalCreate(tag)
      if (tag === 'video') {
        const media = element as HTMLVideoElement
        media.load = vi.fn()
        Object.defineProperty(media, 'src', {
          set: () => queueMicrotask(() => media.dispatchEvent(new Event('error'))),
          get: () => '',
        })
      }
      return element
    })
    files.readFileBytes.mockClear()
    await expect(capturePosterForClip('/data/videos/b.webm')).rejects.toBeInstanceOf(
      PosterCaptureError
    )
    expect(files.readFileBytes).not.toHaveBeenCalled()
    spy.mockRestore()
    create.mockRestore()
    revoke.mockRestore()
  })
})

describe('PosterBackfillQueue', () => {
  it('runs at most `concurrency` captures at once, once per clip, and never retries a failure', async () => {
    const resolvers = new Map<string, { resolve: () => void; reject: (e: Error) => void }>()
    const run = vi.fn(
      (item: { id: string }) =>
        new Promise<void>((resolve, reject) => resolvers.set(item.id, { resolve, reject }))
    )
    const queue = new PosterBackfillQueue({ run, concurrency: 2 })
    const items = ['a', 'b', 'c'].map((id) => makeVideoItem({ id, posterPath: null }))
    for (const item of items) queue.request(item)
    queue.request(items[0])
    expect(run).toHaveBeenCalledTimes(2)
    expect(queue.wants(items[2])).toBe(false)

    resolvers.get('a')!.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(3)
    expect(run.mock.calls.map(([item]) => item.id)).toEqual(['a', 'b', 'c'])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolvers.get('b')!.reject(new Error('no frame'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(queue.hasFailed('b')).toBe(true)
    expect(warn).toHaveBeenCalledWith('[videos] poster for b not made:', expect.any(Error))
    queue.request(items[1])
    expect(run).toHaveBeenCalledTimes(3)

    // A clip that already has a poster is never asked for one.
    queue.request(makeVideoItem({ id: 'd' }))
    expect(run).toHaveBeenCalledTimes(3)
    queue.clear()
    expect(queue.hasFailed('b')).toBe(false)
    warn.mockRestore()
  })

  it('never runs fewer than one at a time', () => {
    const run = vi.fn(async () => {})
    const queue = new PosterBackfillQueue({ run, concurrency: 0 })
    queue.request(makeVideoItem({ id: 'a', posterPath: null }))
    expect(run).toHaveBeenCalledTimes(1)
  })
})

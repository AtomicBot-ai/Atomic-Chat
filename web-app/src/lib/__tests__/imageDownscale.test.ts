import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { downscaleImageDataUrl } from '../imageDownscale'

// A 1x1 PNG data URL; the stubbed Image reports its own dimensions, so the
// payload only has to be a well-formed data URL.
const INPUT = 'data:image/png;base64,iVBORw0KGgo='

const base64OfBytes = (bytes: number) => 'A'.repeat(Math.ceil((bytes * 4) / 3))

type FakeCtx = {
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: string
  drawImage: ReturnType<typeof vi.fn>
  getImageData: ReturnType<typeof vi.fn>
}

let ctx: FakeCtx
let toDataURL: ReturnType<typeof vi.fn>
let pngBytes: number
let jpegBytes: number

/** RGBA pixel buffer for `getImageData`: every pixel opaque except `translucentAt`. */
const pixels = (count: number, translucentAt = -1) => {
  const data = new Uint8ClampedArray(count * 4)
  for (let i = 0; i < count; i++) {
    data[i * 4 + 3] = i === translucentAt ? 254 : 255
  }
  return { data }
}

beforeEach(() => {
  pngBytes = 12 * 1024 * 1024
  jpegBytes = 1 * 1024 * 1024
  ctx = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: '',
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) =>
      pixels(w * h)
    ),
  }
  toDataURL = vi.fn((type: string) =>
    type === 'image/jpeg'
      ? `data:image/jpeg;base64,${base64OfBytes(jpegBytes)}`
      : `data:image/png;base64,${base64OfBytes(pngBytes)}`
  )
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 5120
      naturalHeight = 5120
      onload?: () => void
      onerror?: () => void
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
    toDataURL as unknown as HTMLCanvasElement['toDataURL']
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('downscaleImageDataUrl encoding (#262)', () => {
  it('re-encodes a large opaque PNG as JPEG', async () => {
    const result = await downscaleImageDataUrl(INPUT, 2048, 'image/png')

    expect(result?.mimeType).toBe('image/jpeg')
    expect(result?.size).toBeLessThan(2 * 1024 * 1024)
    expect(toDataURL).toHaveBeenCalledWith('image/png')
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.92)
  })

  it('keeps PNG when the image has transparency', async () => {
    ctx.getImageData.mockImplementation(
      (_x: number, _y: number, w: number, h: number) => pixels(w * h, 7)
    )

    const result = await downscaleImageDataUrl(INPUT, 2048, 'image/png')

    expect(result?.mimeType).toBe('image/png')
    expect(toDataURL).not.toHaveBeenCalledWith('image/jpeg', 0.92)
    // The scan stops at the first translucent pixel.
    expect(ctx.getImageData).toHaveBeenCalledTimes(1)
  })

  it('keeps a small opaque PNG lossless', async () => {
    pngBytes = 1 * 1024 * 1024

    const result = await downscaleImageDataUrl(INPUT, 2048, 'image/png')

    expect(result?.mimeType).toBe('image/png')
    expect(toDataURL).not.toHaveBeenCalledWith('image/jpeg', 0.92)
  })

  it('keeps PNG when JPEG would not be smaller', async () => {
    jpegBytes = pngBytes

    const result = await downscaleImageDataUrl(INPUT, 2048, 'image/png')

    expect(result?.mimeType).toBe('image/png')
  })

  it('never scans a JPEG for alpha', async () => {
    const result = await downscaleImageDataUrl(INPUT, 2048, 'image/jpeg')

    expect(result?.mimeType).toBe('image/jpeg')
    expect(ctx.getImageData).not.toHaveBeenCalled()
    expect(toDataURL).toHaveBeenCalledTimes(1)
  })

  it('transcodes an opaque WebP to JPEG', async () => {
    const result = await downscaleImageDataUrl(INPUT, 2048, 'image/webp')

    expect(result?.mimeType).toBe('image/jpeg')
  })

  it('scans the whole bitmap in bands', async () => {
    // 2048 x 2048 output at 4 bytes per pixel is 16 MB; 4 MB bands → 4 reads.
    await downscaleImageDataUrl(INPUT, 2048, 'image/png')

    expect(ctx.getImageData).toHaveBeenCalledTimes(4)
    const coveredRows = ctx.getImageData.mock.calls.reduce(
      (sum, [, , , h]) => sum + (h as number),
      0
    )
    expect(coveredRows).toBe(2048)
  })
})

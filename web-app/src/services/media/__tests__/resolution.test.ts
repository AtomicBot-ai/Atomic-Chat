import { describe, expect, it } from 'vitest'

import { checkSize, estimateVramMb, outputTarget, snap, type MediaSizeRules } from '../resolution'

// Same values as the Rust catalog's SDXL_RULES / FLUX_RULES / SD1_RULES, and the
// same vectors as the Rust tests in resolution.rs.
const SDXL: MediaSizeRules = {
  native: [1024, 1024],
  multiple: 64,
  min_side: 512,
  max_side: 2048,
  pixel_budget: 1024 * 1024,
  comfortable_min_pixels: 768 * 768,
  comfortable_max_pixels: 1280 * 1280,
  vram_mb_per_megapixel: 1800,
}
const FLUX: MediaSizeRules = { ...SDXL, multiple: 16, min_side: 256, comfortable_min_pixels: 512 * 512, comfortable_max_pixels: 1536 * 1536 }
const SD1: MediaSizeRules = {
  native: [512, 512],
  multiple: 64,
  min_side: 256,
  max_side: 1024,
  pixel_budget: 512 * 512,
  comfortable_min_pixels: 384 * 384,
  comfortable_max_pixels: 768 * 768,
  vram_mb_per_megapixel: 2400,
}

describe('resolution helpers', () => {
  it('snaps to the nearest multiple, never to zero', () => {
    expect(snap(1000, 64)).toBe(1024)
    expect(snap(980, 64)).toBe(960)
    expect(snap(712, 32)).toBe(704)
    expect(snap(3, 16)).toBe(16)
  })

  it('checks custom sizes like the Rust side', () => {
    expect(checkSize(SDXL, 1024, 1024)).toEqual({ width: 1024, height: 1024, adjusted: false, warnings: [] })
    const odd = checkSize(SDXL, 1000, 777)
    expect([odd.width, odd.height, odd.adjusted]).toEqual([1024, 768, true])
    const huge = checkSize(SDXL, 4000, 4000)
    expect([huge.width, huge.height]).toEqual([2048, 2048])
    expect(huge.warnings.some((w) => w.includes('Larger'))).toBe(true)
    const tiny = checkSize(SD1, 10, 10)
    expect([tiny.width, tiny.height]).toEqual([256, 256])
    expect(tiny.warnings.some((w) => w.includes('Smaller'))).toBe(true)
    const flux = checkSize(FLUX, 1000, 1000)
    expect([flux.width, flux.height]).toEqual([1008, 1008])
  })

  it('targets 4K on the long side', () => {
    expect(outputTarget(1280, 720, 3840)).toEqual([3840, 2160])
    expect(outputTarget(1344, 768, 3840)).toEqual([3840, 2194])
    expect(outputTarget(768, 1024, 3840)).toEqual([2880, 3840])
    expect(outputTarget(512, 512, 0)).toEqual([512, 512])
  })

  it('estimates more memory for bigger sizes and longer clips', () => {
    const small = estimateVramMb(SDXL, 8192, 1024, 1024)
    expect(small).toBe(8192 + Math.round(1800 * 1.048576))
    expect(estimateVramMb(SDXL, 8192, 2048, 2048)).toBeGreaterThan(small)
    expect(estimateVramMb(SDXL, 0, 1280, 704, 121)).toBeGreaterThan(estimateVramMb(SDXL, 0, 1280, 704, 33))
  })
})

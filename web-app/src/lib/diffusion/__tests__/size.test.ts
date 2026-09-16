import { describe, expect, it } from 'vitest'

import {
  ASPECT_RATIOS,
  dimOptions,
  formatMegapixels,
  matchAspect,
  sizeForAspect,
  sizeForEdge,
  fitWithin,
  scaleWithin,
  sizeOptions,
  snapDim,
  type DimConstraints,
} from '../size'

const SD = { minDim: 256, maxDim: 2048, dimMultiple: 16 }
const ODD: DimConstraints = { minDim: 200, maxDim: 1000, dimMultiple: 64 }

describe('snapDim', () => {
  it('rounds to the nearest multiple', () => {
    expect(snapDim(1000, SD)).toBe(1008)
    expect(snapDim(1017, SD)).toBe(1024)
    expect(snapDim(1024, SD)).toBe(1024)
  })

  it('clamps to the range', () => {
    expect(snapDim(10, SD)).toBe(256)
    expect(snapDim(9999, SD)).toBe(2048)
  })

  it('snaps the bounds themselves when they are not multiples', () => {
    // 200 is not a multiple of 64: the floor is 256, the ceiling 960.
    expect(snapDim(0, ODD)).toBe(256)
    expect(snapDim(5000, ODD)).toBe(960)
  })

  it('treats a bad multiple or a non-number as the floor', () => {
    expect(snapDim(Number.NaN, SD)).toBe(256)
    expect(snapDim(500, { ...SD, dimMultiple: 0 })).toBe(500)
  })
})

describe('matchAspect', () => {
  it('names the presets in either orientation', () => {
    expect(matchAspect(1024, 1024)).toBe('square')
    expect(matchAspect(1024, 768)).toBe('photo')
    expect(matchAspect(768, 1024)).toBe('photo')
    expect(matchAspect(1536, 1024)).toBe('landscape')
    expect(matchAspect(1920, 1080)).toBe('widescreen')
    expect(matchAspect(2048, 880)).toBe('ultrawide')
  })

  it('falls back to custom for anything else, including bad input', () => {
    expect(matchAspect(1024, 512)).toBe('custom')
    expect(matchAspect(0, 512)).toBe('custom')
  })

  it('tolerates the rounding that snapping introduces', () => {
    // 16:9 at a 1024 long edge snaps the short edge to 576, not 576.0
    const size = sizeForAspect('widescreen', false, 1024, SD)
    expect(matchAspect(size.width, size.height)).toBe('widescreen')
  })
})

describe('sizeForAspect', () => {
  it('derives the short edge from the preset and snaps it', () => {
    expect(sizeForAspect('photo', false, 1024, SD)).toEqual({
      width: 1024,
      height: 768,
    })
    expect(sizeForAspect('widescreen', false, 1024, SD)).toEqual({
      width: 1024,
      height: 576,
    })
  })

  it('flips for portrait', () => {
    expect(sizeForAspect('photo', true, 1024, SD)).toEqual({
      width: 768,
      height: 1024,
    })
  })

  it('keeps the current pair under custom, snapped', () => {
    expect(
      sizeForAspect('custom', false, 1024, SD, { width: 1000, height: 700 })
    ).toEqual({ width: 1008, height: 704 })
  })

  it('never produces a short edge below the floor', () => {
    const size = sizeForAspect('ultrawide', false, 256, SD)
    expect(size.height).toBeGreaterThanOrEqual(256)
  })
})

describe('sizeForEdge', () => {
  const current = { width: 1024, height: 768 }

  it('derives the other edge from the locked ratio', () => {
    expect(sizeForEdge('photo', false, 'width', 1536, SD, current)).toEqual({
      width: 1536,
      height: 1152,
    })
    // 600 snaps to 608 first; 608 × 4/3 = 810.7 snaps to 816.
    expect(sizeForEdge('photo', false, 'height', 600, SD, current)).toEqual({
      width: 816,
      height: 608,
    })
  })

  it('treats the height as the long edge in portrait', () => {
    expect(
      sizeForEdge('widescreen', true, 'height', 1920, SD, { width: 576, height: 1024 })
    ).toEqual({ width: 1088, height: 1920 })
    expect(
      sizeForEdge('widescreen', true, 'width', 576, SD, { width: 576, height: 1024 })
    ).toEqual({ width: 576, height: 1024 })
  })

  it('changes only the edited edge under custom, snapped', () => {
    expect(sizeForEdge('custom', false, 'width', 1000, SD, { width: 512, height: 700 })).toEqual(
      { width: 1008, height: 704 }
    )
  })

  it('never leaves the model range', () => {
    const size = sizeForEdge('ultrawide', false, 'width', 4096, SD, current)
    expect(size.width).toBe(2048)
    expect(size.height).toBeGreaterThanOrEqual(256)
  })
})

describe('dimOptions', () => {
  it('spans the range on the step and always includes both bounds', () => {
    const options = dimOptions(SD)
    expect(options[0]).toBe(256)
    expect(options[options.length - 1]).toBe(2048)
    expect(options).toContain(1024)
    expect(options.every((value) => value % 16 === 0)).toBe(true)
    expect(options).toEqual([...options].sort((a, b) => a - b))
  })

  it('collapses to the two bounds when the step is larger than the range', () => {
    expect(dimOptions({ minDim: 512, maxDim: 640, dimMultiple: 16 }, 512)).toEqual([
      512, 640,
    ])
  })
})

describe('sizeOptions', () => {
  it('lists every size of a preset at its ratio, smallest first', () => {
    const options = sizeOptions('square', false, SD)
    expect(options[0]).toEqual({ width: 256, height: 256 })
    expect(options).toContainEqual({ width: 1024, height: 1024 })
    expect(options[options.length - 1]).toEqual({ width: 2048, height: 2048 })
  })

  it('follows the orientation', () => {
    expect(sizeOptions('photo', false, SD)).toContainEqual({ width: 1024, height: 768 })
    expect(sizeOptions('photo', true, SD)).toContainEqual({ width: 768, height: 1024 })
  })

  it('drops long edges whose short edge would be clamped off the ratio', () => {
    // 21:9 at a 512 long edge needs a 219 short edge, under the 256 floor.
    const options = sizeOptions('ultrawide', false, SD)
    expect(options.some(({ width }) => width === 512)).toBe(false)
    // Snapping to 16 moves the ratio a little; clamping would move it a lot.
    for (const { width, height } of options) {
      expect(Math.abs(width / height - 21 / 9) / (21 / 9)).toBeLessThan(0.05)
    }
  })

  it('has no list for custom', () => {
    expect(sizeOptions('custom', false, SD)).toEqual([])
  })
})

describe('presets', () => {
  it('lists custom last so the free-form inputs sit at the end of the row', () => {
    expect(ASPECT_RATIOS[ASPECT_RATIOS.length - 1].id).toBe('custom')
    expect(ASPECT_RATIOS.filter((preset) => preset.ratio === null)).toHaveLength(1)
  })

  it('formats megapixels with one decimal', () => {
    expect(formatMegapixels(1024, 1024)).toBe('1.0')
    expect(formatMegapixels(1920, 1080)).toBe('2.1')
  })
})

describe('fitWithin', () => {
  it('shrinks to the box, keeps the aspect and snaps', () => {
    expect(fitWithin(4000, 3000, 1024, 1024, SD)).toEqual({ width: 1024, height: 768 })
    expect(fitWithin(1500, 3000, 1024, 1024, SD)).toEqual({ width: 512, height: 1024 })
  })

  it('never enlarges a small source', () => {
    expect(fitWithin(640, 480, 1024, 1024, SD)).toEqual({ width: 640, height: 480 })
  })

  it('falls back to the box for a source with no size', () => {
    expect(fitWithin(0, 0, 1024, 768, SD)).toEqual({ width: 1024, height: 768 })
  })
})

describe('scaleWithin', () => {
  it('multiplies and snaps', () => {
    expect(scaleWithin(512, 384, 2, SD)).toEqual({ width: 1024, height: 768, factor: 2 })
  })

  it('caps the factor so the longer edge stays under the ceiling', () => {
    const scaled = scaleWithin(1600, 1200, 4, SD)
    expect(scaled.width).toBe(2048)
    expect(scaled.height).toBe(1536)
    expect(scaled.factor).toBeCloseTo(1.28)
  })

  it('never shrinks', () => {
    expect(scaleWithin(1024, 1024, 0.5, SD).factor).toBe(1)
  })
})

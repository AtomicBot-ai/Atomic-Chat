import { describe, expect, it } from 'vitest'

import { ALL_SIDES, anySide, outpaintGeometry, SEAM_OVERLAP } from '../outpaint'

const SD = { minDim: 256, maxDim: 2048, dimMultiple: 16 }

describe('outpaintGeometry', () => {
  it('grows every chosen side by the percentage and keeps the original centred', () => {
    const g = outpaintGeometry({
      width: 1024,
      height: 768,
      expandPercent: 25,
      sides: ALL_SIDES,
      constraints: SD,
    })
    // 1024 + 2×256 = 1536, 768 + 2×192 = 1152: both already on the grid.
    expect([g.width, g.height]).toEqual([1536, 1152])
    expect([g.offsetX, g.offsetY]).toEqual([256, 192])
    expect([g.drawWidth, g.drawHeight]).toEqual([1024, 768])
  })

  it('leaves unchosen sides alone', () => {
    const g = outpaintGeometry({
      width: 1024,
      height: 768,
      expandPercent: 50,
      sides: { top: false, bottom: true, left: false, right: true },
      constraints: SD,
    })
    expect([g.width, g.height]).toEqual([1536, 1152])
    expect([g.offsetX, g.offsetY]).toEqual([0, 0])
    // The keep rectangle only backs off from the grown edges.
    expect(g.keep.x).toBe(0)
    expect(g.keep.y).toBe(0)
    expect(g.keep.width).toBe(1024 - Math.round(1024 * SEAM_OVERLAP))
    expect(g.keep.height).toBe(768 - Math.round(768 * SEAM_OVERLAP))
  })

  it('insets the keep rectangle by the seam overlap on grown sides', () => {
    const g = outpaintGeometry({
      width: 1000,
      height: 1000,
      expandPercent: 10,
      sides: ALL_SIDES,
      constraints: SD,
    })
    const inset = Math.round(g.drawWidth * SEAM_OVERLAP)
    expect(g.keep.x).toBe(g.offsetX + inset)
    expect(g.keep.width).toBe(g.drawWidth - 2 * inset)
  })

  it('scales the whole picture down when the grown canvas is over the ceiling', () => {
    const g = outpaintGeometry({
      width: 2048,
      height: 1024,
      expandPercent: 50,
      sides: ALL_SIDES,
      constraints: SD,
    })
    expect(g.width).toBe(2048)
    expect(g.height).toBeLessThanOrEqual(2048)
    expect(g.width % 16).toBe(0)
    expect(g.height % 16).toBe(0)
    // Every side still got its share: the original is drawn smaller, inside.
    expect(g.offsetX).toBeGreaterThan(0)
    expect(g.drawWidth).toBeLessThan(2048)
    expect(g.offsetX + g.drawWidth).toBeLessThan(g.width)
  })

  it('snaps the canvas to the model grid', () => {
    const g = outpaintGeometry({
      width: 1000,
      height: 700,
      expandPercent: 15,
      sides: ALL_SIDES,
      constraints: SD,
    })
    expect(g.width % 16).toBe(0)
    expect(g.height % 16).toBe(0)
  })
})

describe('anySide', () => {
  it('is false only when every side is off', () => {
    expect(anySide(ALL_SIDES)).toBe(true)
    expect(anySide({ top: false, bottom: false, left: false, right: true })).toBe(true)
    expect(anySide({ top: false, bottom: false, left: false, right: false })).toBe(false)
  })
})

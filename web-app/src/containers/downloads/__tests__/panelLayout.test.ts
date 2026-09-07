import { describe, expect, it } from 'vitest'

import { panelLayout } from '../panelLayout'

const VIEWPORT = { width: 1280, height: 800 }

/** Composer as a thread renders it: full content column, pinned to the bottom. */
const composerAtBottom = {
  top: 660,
  bottom: 784,
  left: 400,
  right: 1104,
  height: 124,
}

/** Composer as the empty home screen renders it: same column, centred. */
const composerCentred = {
  top: 340,
  bottom: 464,
  left: 400,
  right: 1104,
  height: 124,
}

describe('panelLayout', () => {
  it('sits in the corner when there is no composer', () => {
    const layout = panelLayout(null, VIEWPORT)
    expect(layout.bottom).toBe(16)
    expect(layout.listMax).toBe(208)
  })

  it('sits in the corner when the composer is a zero-height stub', () => {
    // A composer that has not laid out yet must not push the panel around.
    const layout = panelLayout({ ...composerAtBottom, height: 0 }, VIEWPORT)
    expect(layout.bottom).toBe(16)
  })

  it('sits above a composer pinned to the bottom of a thread', () => {
    // There is no usable room under it, and covering the send button would
    // break typing to a model while it downloads.
    const layout = panelLayout(composerAtBottom, VIEWPORT)
    expect(layout.bottom).toBe(800 - 660 + 12)

    const panelTop = VIEWPORT.height - layout.bottom
    expect(panelTop).toBeLessThanOrEqual(composerAtBottom.top)
  })

  it('stays in the corner under a centred composer, giving up height', () => {
    const layout = panelLayout(composerCentred, VIEWPORT)
    expect(layout.bottom).toBe(16)

    // Whatever height it keeps has to fit between the composer and the corner.
    const available = VIEWPORT.height - 16 - (composerCentred.bottom + 12)
    expect(layout.listMax).toBeLessThanOrEqual(available)

    const panelTop = VIEWPORT.height - 16 - (layout.listMax + 44)
    expect(panelTop).toBeGreaterThanOrEqual(composerCentred.bottom)
  })

  it('ignores a composer that does not reach the panel column', () => {
    // On a wide window the content column stops well short of the right edge,
    // so there is nothing to avoid and the panel keeps its full height.
    const wide = { width: 2400, height: 800 }
    const layout = panelLayout(
      { top: 660, bottom: 784, left: 700, right: 1700, height: 124 },
      wide
    )
    expect(layout.bottom).toBe(16)
    expect(layout.listMax).toBe(208)
  })

  it('shrinks the cap on a short window', () => {
    // 30% of the window, so the panel never dominates a small screen.
    const layout = panelLayout(null, { width: 1280, height: 600 })
    expect(layout.listMax).toBe(180)
  })

  it('always leaves room for at least one row', () => {
    // A tall composer in a short window leaves almost nothing above it; the
    // panel must still be able to show something rather than collapse to 0.
    const layout = panelLayout(
      { top: 120, bottom: 560, left: 100, right: 1200, height: 440 },
      { width: 1280, height: 600 }
    )
    expect(layout.listMax).toBeGreaterThanOrEqual(80)
  })

  it('never returns a negative offset', () => {
    const layout = panelLayout(composerAtBottom, VIEWPORT)
    expect(layout.bottom).toBeGreaterThanOrEqual(16)
    expect(layout.listMax).toBeGreaterThan(0)
  })
})

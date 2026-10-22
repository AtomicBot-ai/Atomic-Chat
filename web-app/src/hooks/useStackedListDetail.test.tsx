import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isListDetailStacked,
  useStackedListDetail,
  type ListDetailGeometry,
} from './useStackedListDetail'

/** The Skills page: a 360 px list, 58 px of inset, a 36em reading line. */
const GEOMETRY: ListDetailGeometry = {
  listWidth: 360,
  detailInset: 58,
  detailMeasureEm: 36,
}

describe('isListDetailStacked', () => {
  it('stacks a 1024 px window with the sidebar open at Medium', () => {
    // 1024 − 60 px rail − 256 px sidebar; body text is 14 px at Medium.
    expect(isListDetailStacked(708, 14, GEOMETRY)).toBe(true)
  })

  it('keeps side by side when the detail gets its full measure', () => {
    // 1280 with the sidebar open: 964 − 360 − 58 = 546 px ≥ 36 × 14.
    expect(isListDetailStacked(964, 14, GEOMETRY)).toBe(false)
    expect(isListDetailStacked(360 + 58 + 36 * 14, 14, GEOMETRY)).toBe(false)
    expect(isListDetailStacked(360 + 58 + 36 * 14 - 1, 14, GEOMETRY)).toBe(true)
  })

  it('stacks the same width sooner at a larger interface font', () => {
    // Extra Large: 17.5 px body text needs 630 px beside the list.
    expect(isListDetailStacked(964, 17.5, GEOMETRY)).toBe(true)
  })

  it('keeps the side-by-side default for an element with no box', () => {
    expect(isListDetailStacked(0, 14, GEOMETRY)).toBe(false)
    expect(isListDetailStacked(708, Number.NaN, GEOMETRY)).toBe(false)
  })
})

describe('useStackedListDetail', () => {
  const observers: Array<() => void> = []

  afterEach(() => {
    observers.length = 0
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function Probe() {
    const { ref, stacked } = useStackedListDetail<HTMLDivElement>(GEOMETRY)
    return (
      <div ref={ref} style={{ fontSize: '14px' }}>
        {stacked ? 'stacked' : 'side by side'}
      </div>
    )
  }

  it('measures the page before paint and follows it as it resizes', () => {
    let width = 708
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width }) as DOMRect
    )
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          observers.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )

    render(<Probe />)
    expect(screen.getByText('stacked')).toBeInTheDocument()

    width = 964
    act(() => observers.forEach((notify) => notify()))
    expect(screen.getByText('side by side')).toBeInTheDocument()
  })

  it('measures again when the interface font size changes', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 964,
    } as DOMRect)
    const root = document.documentElement
    const previous = root.style.getPropertyValue('--font-size-base')

    try {
      render(<Probe />)
      const page = screen.getByText('side by side')

      // Extra Large: the page's body text grows, the page itself does not.
      page.style.fontSize = '17.5px'
      await act(async () => {
        root.style.setProperty('--font-size-base', '20px')
      })
      expect(screen.getByText('stacked')).toBeInTheDocument()
    } finally {
      root.style.setProperty('--font-size-base', previous)
    }
  })
})

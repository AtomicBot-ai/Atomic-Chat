import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import HeaderPage from '@/containers/HeaderPage'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  setFontSize,
  settle,
  withTranslations,
} from '@/test/layout'
import { HubSearchField } from './HubSearchField'

/**
 * The hub header's search field pulls to the list column's 8px insets with
 * negative margins. Collapsed, `HeaderPage` renders the sidebar toggle in the
 * same `gap-2` row — the left pull must not apply there, or the field lands
 * flush against the toggle (PR #313 review).
 */

// The hub column is `minmax(320px, 420px)` in the route's grid.
const cases = [320, 420].flatMap((width) =>
  [DEFAULT_FONT_SIZE, XL_FONT_SIZE].map((fontSize) => ({ width, fontSize }))
)

function renderHeader(width: number): HTMLElement {
  const { container } = render(
    withTranslations(
      <div style={{ width }}>
        <HeaderPage>
          <HubSearchField
            loading={false}
            value=""
            onChange={() => {}}
            onClear={() => {}}
          />
        </HeaderPage>
      </div>
    )
  )
  // container > width wrapper > HeaderPage root.
  return container.firstElementChild!.firstElementChild as HTMLElement
}

/** The field's pull into the header padding, read off the `-mr-2` wrapper. */
function rightPull(field: HTMLElement): number {
  return -parseFloat(getComputedStyle(field.parentElement!).marginRight)
}

beforeEach(() => {
  useLeftPanel.setState({ open: false })
})

describe('HubSearchField header geometry (Chromium)', () => {
  it.each(cases)(
    'collapsed panel: field keeps the row gap from the toggle ($width px, $fontSize)',
    async ({ width, fontSize }) => {
      setFontSize(fontSize)
      const header = renderHeader(width)
      await settle()

      const toggle = screen.getByRole('button', { name: 'Toggle sidebar' })
      const field = screen.getByTestId('hub-search-field')
      // The toggle sits in HeaderPage's `gap-2` flex row; read the gap the
      // field must respect rather than hardcoding 8 against the type scale.
      const rowGap = parseFloat(
        getComputedStyle(toggle.parentElement!).columnGap
      )

      const t = toggle.getBoundingClientRect()
      const f = field.getBoundingClientRect()
      const h = header.getBoundingClientRect()

      expect(
        f.left - t.right,
        'field eats the gap next to the toggle'
      ).toBeCloseTo(rowGap, 1)
      expect(
        h.right - f.right,
        'field misses the right column inset'
      ).toBeCloseTo(rightPull(field), 1)
      if (fontSize === DEFAULT_FONT_SIZE) {
        expect(rowGap).toBeCloseTo(8, 1)
      }
    }
  )

  it.each(cases)(
    'expanded panel: field lands on both column insets ($width px, $fontSize)',
    async ({ width, fontSize }) => {
      useLeftPanel.setState({ open: true })
      setFontSize(fontSize)
      const header = renderHeader(width)
      await settle()

      expect(
        screen.queryByRole('button', { name: 'Toggle sidebar' })
      ).toBeNull()
      const field = screen.getByTestId('hub-search-field')
      const inset = rightPull(field)

      const f = field.getBoundingClientRect()
      const h = header.getBoundingClientRect()

      expect(f.left - h.left, 'field misses the left column inset').toBeCloseTo(
        inset,
        1
      )
      expect(
        h.right - f.right,
        'field misses the right column inset'
      ).toBeCloseTo(inset, 1)
      if (fontSize === DEFAULT_FONT_SIZE) {
        expect(inset).toBeCloseTo(8, 1)
      }
    }
  )
})

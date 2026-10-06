import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_HUB_FILTERS,
  type HubFilterState,
  type HubSortKey,
} from '@/lib/hub-filters'
import type { ModelFormat } from '@/lib/model-card'
import {
  DEFAULT_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  setFontSize,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'
import { HubFilters } from './HubFilters'

vi.mock('@/hooks/useHardware', () => ({
  useHardware: (selector: (state: unknown) => unknown) =>
    selector({ hardwareData: { total_memory: 32 * 1024, gpus: [] } }),
}))
// The TensorRT-LLM provider is shown: the format menu offers it next to GGUF.
vi.mock('@/hooks/useTensorrtHubState', () => ({
  useTensorrtHubState: () => ({
    visible: true,
    state: 'ready',
    blockers: [],
    descriptorId: null,
  }),
}))
// PrismML is shown too: its label is wider than GGUF's, narrower than TensorRT-LLM's.
vi.mock('@/hooks/useModelSetup', () => ({ usePrismHubVisible: () => true }))

/**
 * The Hub's left column at its narrowest: `minmax(320px, 420px)` less the
 * filter block's `p-3` on both sides.
 */
const COLUMN_WIDTH = 320 - 2 * 12

function inColumn(state: HubFilterState, width = COLUMN_WIDTH) {
  return withTranslations(
    <div data-testid="column" style={{ width }}>
      <HubFilters state={state} onChange={() => {}} />
    </div>
  )
}

function renderInColumn() {
  render(inColumn({ ...DEFAULT_HUB_FILTERS, formats: ['tensorrt-llm'] }))
}

const FORMATS: ModelFormat[] = ['gguf', 'atomic-prism', 'tensorrt-llm']
const SORTS: HubSortKey[] = ['recommended', 'downloads', 'last-modified']
/** The column at its widest, `420px` less `p-3` on both sides. */
const WIDE_COLUMN_WIDTH = 420 - 2 * 12

/** Where Uncensored and the format trigger sit, for one filter state. */
async function measureRow(
  rerender: (ui: ReactElement) => void,
  state: HubFilterState,
  width: number
) {
  rerender(inColumn(state, width))
  await settle()
  const { left, top, width: w } = screen
    .getByRole('checkbox', { name: /uncensored/i })
    .getBoundingClientRect()
  return {
    uncensored: { left, top, width: w },
    formatTop: screen.getByRole('button', { name: 'Formats' }).getBoundingClientRect()
      .top,
  }
}

describe('HubFilters layout', () => {
  for (const [label, size] of [
    ['Medium', DEFAULT_FONT_SIZE],
    ['Extra Large', XL_FONT_SIZE],
  ] as const) {
    it(`keeps Uncensored inside the column with TensorRT-LLM selected (${label})`, async () => {
      setFontSize(size)
      renderInColumn()
      await settle()

      const column = screen.getByTestId('column')
      expectFits(screen.getByRole('checkbox', { name: /uncensored/i }), column)
      expectNoHorizontalOverflow(column)
    })
  }

  // Uncensored sits on the triggers' line, pinned to its end: picking a format
  // or a sort moves it neither between lines nor along the line.
  for (const [width, label, size] of [
    [COLUMN_WIDTH, 'Medium', DEFAULT_FONT_SIZE],
    [WIDE_COLUMN_WIDTH, 'Medium', DEFAULT_FONT_SIZE],
    [COLUMN_WIDTH, 'Extra Large', XL_FONT_SIZE],
  ] as const) {
    it(`pins Uncensored to the first line whichever format or sort is picked (${width}px, ${label})`, async () => {
      setFontSize(size)
      const { rerender } = render(inColumn(DEFAULT_HUB_FILTERS, width))
      const first = await measureRow(rerender, DEFAULT_HUB_FILTERS, width)

      for (const format of FORMATS) {
        for (const sort of SORTS) {
          const row = await measureRow(
            rerender,
            { ...DEFAULT_HUB_FILTERS, formats: [format], sort },
            width
          )
          expect(row.uncensored, `${format} / ${sort}`).toEqual(first.uncensored)
          expect(row.uncensored.top, `${format} / ${sort}`).toBe(row.formatTop)
          const column = screen.getByTestId('column')
          expectFits(screen.getByRole('checkbox', { name: /uncensored/i }), column)
          expectNoHorizontalOverflow(column)
        }
      }
    })
  }
})

import { render, screen } from '@testing-library/react'
import { describe, it, vi } from 'vitest'

import { DEFAULT_HUB_FILTERS } from '@/lib/hub-filters'
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
vi.mock('@/hooks/useManagedHubState', () => ({
  useManagedHubState: () => ({
    visible: true,
    state: 'ready',
    blockers: [],
    descriptorId: null,
  }),
}))

/**
 * The Hub's left column at its narrowest: `minmax(320px, 420px)` less the
 * filter block's `p-3` on both sides.
 */
const COLUMN_WIDTH = 320 - 2 * 12

function renderInColumn() {
  render(
    withTranslations(
      <div data-testid="column" style={{ width: COLUMN_WIDTH }}>
        <HubFilters
          state={{ ...DEFAULT_HUB_FILTERS, formats: ['tensorrt-llm'] }}
          onChange={() => {}}
        />
      </div>
    )
  )
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
})

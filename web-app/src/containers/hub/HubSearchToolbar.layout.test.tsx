import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  expectVerticallyCentered,
  setFontSize,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'
import { seedServiceHub } from '@/test/service-hub'
import { HubCategorySelect } from '@/containers/hub/HubCategorySelect'
import { HubFilters } from '@/containers/hub/HubFilters'
import { useModelProvider } from '@/hooks/useModelProvider'
import { DEFAULT_HUB_FILTERS } from '@/lib/hub-filters'
import { HUB_CATEGORIES } from '@/lib/hub-media'
import { HubSearchToolbar } from './HubSearchToolbar'

vi.mock('@/hooks/useHardware', () => ({
  useHardware: (selector: (state: unknown) => unknown) =>
    selector({ hardwareData: { total_memory: 32 * 1024, gpus: [] } }),
}))

const RAIL = 60
const SIDEBAR = 240
/** The page header's row: the window less the rail, the open sidebar and its `px-4`. */
const toolbarWidth = (window: number) => window - RAIL - SIDEBAR

function renderToolbar(width: number) {
  return render(
    withTranslations(
      <div
        className="app-shell"
        style={{ height: 'auto', paddingTop: 0, overflow: 'visible' }}
      >
        <div data-testid="page" style={{ width }}>
          <HubSearchToolbar
            value="qwen3 coder"
            onChange={() => {}}
            placeholder="Search for models on Hugging Face..."
            modelType={
              <HubCategorySelect
                categories={HUB_CATEGORIES}
                value="embedding"
                onChange={() => {}}
              />
            }
            controls={
              <HubFilters
                state={{ ...DEFAULT_HUB_FILTERS, uncensored: true }}
                onChange={() => {}}
                showOnlyDownloaded
              />
            }
          />
        </div>
      </div>
    )
  )
}

const controls = () => [
  screen.getByTestId('hub-category-workflow-select'),
  screen.getByRole('textbox'),
  screen.getByRole('button', { name: 'Filter models' }),
  screen.getByRole('button', { name: 'Sort by' }),
  screen.getByRole('button', { name: /Import file/ }),
]

describe('HubSearchToolbar layout', () => {
  beforeEach(() => {
    seedServiceHub({})
    useModelProvider.setState({
      providers: [
        { provider: 'llamacpp-upstream', models: [], settings: [] } as never,
      ],
    })
  })
  afterEach(() => {
    setFontSize(DEFAULT_FONT_SIZE)
  })

  for (const [label, size] of [
    ['Medium', DEFAULT_FONT_SIZE],
    ['Extra Large', XL_FONT_SIZE],
  ] as const) {
    for (const window of [1024, 1280]) {
      it(`keeps type, search, Filters, Sort and Import on one 36px line (${window}px window with the sidebar, ${label})`, async () => {
        setFontSize(size)
        renderToolbar(toolbarWidth(window))
        await settle()

        const page = screen.getByTestId('page')
        expectNoHorizontalOverflow(page)
        const [type, search, ...buttons] = controls()
        const field = search.closest('.hub-search-field') as HTMLElement
        for (const control of [type, field, ...buttons]) {
          expect(control.getBoundingClientRect().height).toBeCloseTo(36, 0)
          expectVerticallyCentered(control, field)
          expectFits(control, page)
        }
        // The search takes the spare width, never less than its floor.
        expect(field.getBoundingClientRect().width).toBeGreaterThanOrEqual(120)
      })
    }

    it(`wraps a narrow toolbar onto a second line instead of overflowing (${label})`, async () => {
      setFontSize(size)
      renderToolbar(520)
      await settle()

      const page = screen.getByTestId('page')
      expectNoHorizontalOverflow(page)
      for (const control of controls()) expectFits(control, page)
    })
  }
})

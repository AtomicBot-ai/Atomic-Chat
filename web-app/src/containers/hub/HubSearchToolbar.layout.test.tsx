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
import i18n from '@/i18n/setup'
import { DEFAULT_HUB_FILTERS } from '@/lib/hub-filters'
import { HUB_CATEGORIES } from '@/lib/hub-media'
import { HubSearchToolbar } from './HubSearchToolbar'

vi.mock('@/hooks/useHardware', () => ({
  useHardware: (selector: (state: unknown) => unknown) =>
    selector({ hardwareData: { total_memory: 32 * 1024, gpus: [] } }),
}))

const RAIL = 60
const SIDEBAR = 240
/** The sidebar dragged to its widest, `MAX_SIDEBAR_WIDTH` (40rem). */
const WIDEST_SIDEBAR = 640
/** The page header's row: the window less the rail, the open sidebar and its `px-4`. */
const toolbarWidth = (window: number, sidebar = SIDEBAR) =>
  window - RAIL - sidebar
/** Search keeps this much while it shares a row with Filters, Sort and Import. */
const USEFUL_SEARCH = 256

function renderToolbar(width: number, value = 'qwen3 coder') {
  return render(
    withTranslations(
      <div
        className="app-shell"
        style={{ height: 'auto', paddingTop: 0, overflow: 'visible' }}
      >
        <div data-testid="page" style={{ width }}>
          <HubSearchToolbar
            value={value}
            onChange={() => {}}
            placeholder={i18n.t('hub:searchPlaceholder')}
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

/** Filters, Sort and Import, by their names in the current language. */
const actions = () =>
  ['hub:filters.label', 'hub:sortBy', 'hub:import.button'].map((key) =>
    screen.getByRole('button', { name: i18n.t(key) })
  )

const controls = () => [
  screen.getByTestId('hub-category-workflow-select'),
  screen.getByRole('textbox'),
  ...actions(),
]

/** Width of `text` set in `el`'s own font, in px. */
function textWidth(el: HTMLElement, text: string): number {
  const style = getComputedStyle(el)
  const context = document.createElement('canvas').getContext('2d')
  if (!context) expect.fail('canvas 2d context unavailable')
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  return context.measureText(text).width
}

/** Run `check`, naming the case in the failure: a sweep reports where it broke. */
function at(where: string, check: () => void): void {
  try {
    check()
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`)
  }
}

describe('HubSearchToolbar layout', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    seedServiceHub({})
    useModelProvider.setState({
      providers: [
        { provider: 'llamacpp-upstream', models: [], settings: [] } as never,
      ],
    })
  })
  afterEach(async () => {
    setFontSize(DEFAULT_FONT_SIZE)
    await i18n.changeLanguage('en')
  })

  for (const [label, size] of [
    ['Medium', DEFAULT_FONT_SIZE],
    ['Extra Large', XL_FONT_SIZE],
  ] as const) {
    for (const window of [1024, 1280]) {
      it(`keeps type, search, Filters, Sort and Import on one 28px line (${window}px window with the sidebar, ${label})`, async () => {
        setFontSize(size)
        renderToolbar(toolbarWidth(window))
        await settle()

        const page = screen.getByTestId('page')
        expectNoHorizontalOverflow(page)
        const [type, search, ...buttons] = controls()
        const field = search.closest('.hub-search-field') as HTMLElement
        for (const control of [type, field, ...buttons]) {
          expect(control.getBoundingClientRect().height).toBeCloseTo(28, 0)
          expectVerticallyCentered(control, field)
          expectFits(control, page)
        }
        // The search is the row's main control, not the leftover between
        // wide action labels.
        expect(field.getBoundingClientRect().width).toBeGreaterThanOrEqual(
          USEFUL_SEARCH
        )
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

    for (const language of ['en', 'ru']) {
      it(`shows the whole placeholder and every action across the window's widths (${language}, ${label})`, async () => {
        await i18n.changeLanguage(language)
        setFontSize(size)
        renderToolbar(toolbarWidth(1280), '')
        const page = screen.getByTestId('page')
        const input = screen.getByRole('textbox') as HTMLInputElement
        const field = input.closest('.hub-search-field') as HTMLElement
        const placeholder = textWidth(input, input.placeholder)

        // From a 1024 px window with the sidebar dragged to its widest to a
        // 1280 px one with the default sidebar.
        const narrowest = toolbarWidth(1024, WIDEST_SIDEBAR)
        const widest = toolbarWidth(1280)
        for (let width = narrowest; width <= widest; width += 16) {
          page.style.width = `${width}px`
          await settle()
          at(`${width}px toolbar`, () => {
            expectNoHorizontalOverflow(page)
            expect(
              placeholder,
              'the placeholder is cut off inside the search field'
            ).toBeLessThanOrEqual(input.clientWidth + 0.5)
            const filters = actions()[0]
            for (const control of [field, ...actions()]) {
              expectFits(control, page)
            }
            for (const button of actions()) {
              // No label wraps inside its button or spills out of it.
              expect(button.getBoundingClientRect().height).toBeCloseTo(28, 0)
              expect(button.scrollWidth).toBeLessThanOrEqual(
                button.clientWidth + 1
              )
            }
            const sharesRow =
              Math.abs(
                field.getBoundingClientRect().top -
                  filters.getBoundingClientRect().top
              ) < 1
            if (sharesRow) {
              expect(
                field.getBoundingClientRect().width,
                'search squeezed by the actions beside it'
              ).toBeGreaterThanOrEqual(USEFUL_SEARCH)
            }
          })
        }
      })
    }
  }
})

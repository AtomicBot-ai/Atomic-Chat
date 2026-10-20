import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_HUB_FILTERS } from '@/lib/hub-filters'
import {
  DEFAULT_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectSameHeight,
  expectVerticallyCentered,
  setFontSize,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'
import { useModelProvider } from '@/hooks/useModelProvider'
import { HubFilters } from './HubFilters'

vi.mock('@/hooks/useHardware', () => ({
  useHardware: (selector: (state: unknown) => unknown) =>
    selector({ hardwareData: { total_memory: 32 * 1024, gpus: [] } }),
}))
// Every managed engine is shown: the longest menu the Filters can hold.
vi.mock('@/hooks/useManagedHubState', () => {
  const hub = {
    visible: true,
    state: 'ready',
    blockers: [],
    descriptorId: null,
  }
  return {
    useManagedHubStates: () => [
      { engine: { id: 'vllm', label: 'vLLM', i18n: 'vllm' }, hub },
      { engine: { id: 'sglang', label: 'SGLang', i18n: 'sglang' }, hub },
      {
        engine: { id: 'tensorrt-llm', label: 'TensorRT-LLM', i18n: 'tensorrt' },
        hub,
      },
    ],
  }
})

describe('HubFilters layout', () => {
  beforeEach(() => {
    useModelProvider.setState({
      providers: [
        'llamacpp-upstream',
        'llamacpp',
        'atomic-prism',
        'foundry-local',
      ].map((provider) => ({ provider, models: [], settings: [] }) as never),
    })
  })
  afterEach(() => {
    setFontSize(DEFAULT_FONT_SIZE)
  })

  for (const [label, size] of [
    ['Medium', DEFAULT_FONT_SIZE],
    ['Extra Large', XL_FONT_SIZE],
  ] as const) {
    it(`keeps Filters with its count and Sort on one line of equal controls (${label})`, async () => {
      setFontSize(size)
      render(
        withTranslations(
          <div
            className="app-shell"
            style={{ height: 'auto', paddingTop: 0, overflow: 'visible' }}
          >
            <div data-testid="row" style={{ width: 'max-content' }}>
              <HubFilters
                state={{ ...DEFAULT_HUB_FILTERS, uncensored: true }}
                onChange={() => {}}
                showOnlyDownloaded
              />
            </div>
          </div>
        )
      )
      await settle()

      const filters = screen.getByRole('button', { name: 'Filter models' })
      const sort = screen.getByRole('button', { name: 'Sort by' })
      expect(filters).toHaveTextContent('3')
      for (const button of [filters, sort]) {
        // 36px tall: the label and the count did not wrap.
        expect(button.getBoundingClientRect().height).toBeCloseTo(36, 0)
      }
      expectVerticallyCentered(within(filters).getByText('3'), filters)
      expect(filters.getBoundingClientRect().top).toBeCloseTo(
        sort.getBoundingClientRect().top,
        0
      )
    })

    it(`holds every engine and format name in the Filters menu without a sideways scrollbar (${label})`, async () => {
      setFontSize(size)
      const user = userEvent.setup()
      render(
        withTranslations(
          <HubFilters
            state={{ ...DEFAULT_HUB_FILTERS, formats: ['tensorrt-llm'] }}
            onChange={() => {}}
          />
        )
      )
      await user.click(screen.getByRole('button', { name: 'Filter models' }))
      const menu = await screen.findByRole('menu')
      await settle()

      // Every name keeps to the menu's width; the menu scrolls down, never
      // sideways.
      expectNoHorizontalOverflow(menu)
      // No option wraps: the longest is as tall as GGUF's.
      expectSameHeight(
        [
          'GGUF',
          'llama.cpp turboquant',
          'PrismML llama.cpp',
          'TensorRT-LLM',
          'Foundry Local',
        ].flatMap((name) =>
          within(menu).getAllByRole('menuitemradio', { name })
        )
      )
      expectSameHeight(
        ['Liked models', 'Only show models that fit'].map((name) =>
          within(menu).getByRole('menuitemcheckbox', { name })
        )
      )
      // A menu taller than the window scrolls inside itself.
      expect(menu.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        window.innerHeight
      )
    })
  }
})

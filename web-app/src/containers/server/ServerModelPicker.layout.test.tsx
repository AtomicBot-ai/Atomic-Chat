import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  expectSameWidth,
  setFontSize,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'

// Geometry only: nothing is started or saved here.
vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => ({
    status: 'stopped',
    isRunning: false,
    isModelLoading: false,
    isBusy: false,
    start: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
    refreshStatus: vi.fn(),
  }),
}))
vi.mock('@/hooks/useServiceHub', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useServiceHub')>()),
  useServiceHub: () => ({}),
}))
vi.mock('./useServedHelperModels', () => {
  const none = { supported: false, options: [], active: 'none', apply: vi.fn() }
  return {
    NO_HELPER_MODEL: 'none',
    useServedEmbeddingModels: () => none,
    useServedDecisionModels: () => none,
  }
})

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'

import { ServerModelPicker } from './ServerModelPicker'

// Server → Engine & model's column at a 1024 px window: the window less the
// 60 px rail, the 256 px sidebar and the page's padding.
const COLUMN_WIDTH = 676

const LONG_ID =
  'unsloth/Qwen3.5-35B-A3B-Instruct-UD-Q4_K_XL-with-a-very-long-file-name-that-does-not-break'

describe('Server → Engine & model pickers', () => {
  beforeEach(() => {
    useLocalApiServer.setState({
      defaultModelLocalApiServer: null,
      lastServerModels: [],
    })
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          persist: true,
          settings: [],
          models: [
            { id: LONG_ID, sizeBytes: 21 * 1024 ** 3 },
            { id: 'qwen3.5-4b', name: 'Qwen3.5 4B', sizeBytes: 2.7e9 },
          ],
        } as unknown as ModelProvider,
      ],
    })
  })
  afterEach(() => setFontSize(DEFAULT_FONT_SIZE))

  it.each([DEFAULT_FONT_SIZE, XL_FONT_SIZE])(
    'keeps a long model name inside the field, and opens a menu as wide as it (%s)',
    async (fontSize) => {
      setFontSize(fontSize)
      render(
        withTranslations(
          <div
            className="server-page"
            style={{ width: COLUMN_WIDTH }}
            data-testid="page"
          >
            <ServerModelPicker />
          </div>
        )
      )
      const page = screen.getByTestId('page')
      await settle(page)

      expectNoHorizontalOverflow(page)
      const model = screen.getByRole('button', { name: 'Model' })
      expectFits(model, page)

      await userEvent.click(model)
      const menu = await screen.findByRole('menu')
      await settle(menu)

      expectSameWidth([menu, model])
      expectNoHorizontalOverflow(menu)
      for (const row of screen.getAllByRole('menuitemradio'))
        expectFits(row, menu)
    }
  )
})

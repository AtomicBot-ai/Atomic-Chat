import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from '@vitest/browser/context'
import DropdownModelProvider from './DropdownModelProvider'
import { resetModelPickerDownloadsForTest } from './ModelPickerDownloads'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import type { CatalogModel, ModelsService } from '@/services/models/types'
import i18n from '@/i18n/setup'
import { getProviderTitle } from '@/lib/utils'
import { seedServiceHub } from '@/test/service-hub'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  expectSameWidth,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => () => {} }))
vi.mock('@/hooks/useRecommendedDownloads', () => ({
  useRecommendedDownloads: () => ({ items: [], isLoading: false }),
}))
vi.mock('@/containers/SetupScreen', () => ({
  describeRecommendationFit: () => null,
}))
vi.mock('@/containers/dialogs/AddCloudProviderDialog', () => ({
  AddCloudProviderDialog: () => null,
  selectCloudGalleryProviders: () => [],
}))
vi.mock('@/containers/ModelSupportStatus', () => ({
  ModelSupportStatus: () => null,
}))
vi.mock('@/containers/InferenceServerStatus', () => ({
  InferenceServerStatusLine: () => null,
}))
vi.mock('@/containers/ActiveModelIndicator', () => ({
  ActiveModelIndicator: () => null,
}))
vi.mock('@/containers/ReasoningEffortPanel', () => ({ default: () => null }))
vi.mock('@/hooks/useReasoningEffort', () => ({
  useReasoningEffort: () => ({ levelLabel: '' }),
}))

const repo = 'community/Qwen3-235B-A22B-Instruct-2507-Long-Context'
const candidate = (is_mlx: boolean): CatalogModel => ({
  model_name: repo,
  is_mlx,
  description: '',
  downloads: 1,
})
const search = vi.fn()
const translate = i18n.t
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.stubGlobal('IS_MACOS', true)
  resetModelPickerDownloadsForTest()
  useDownloadStore.setState({
    downloads: {},
    localDownloadingModels: new Set(),
    pausedDownloads: new Set(),
  })
  useModelProvider.setState({
    providers: [],
    selectedProvider: '',
    selectedModel: undefined,
  })
  seedServiceHub({
    models: {
      searchHuggingFaceCandidates: search,
      getActiveModels: async () => [],
      checkMmprojExists: async () => false,
      fetchHuggingFaceRepo: async () => ({ siblings: [] }),
      convertHfRepoToCatalogModel: () => ({
        ...candidate(false),
        quants: [
          {
            model_id: 'layout-Q4_K_M',
            path: 'https://example.test/model.gguf',
            file_size: '19.7 GB',
          },
        ],
      }),
      pullModelWithMetadata: async () => undefined,
    } as unknown as ModelsService,
  })
})

describe('model selector geometry', () => {
  for (const width of [1024, 1280, 390]) {
    for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
      for (const theme of ['light', 'dark'] as const) {
        it(`${width}px, ${font}, ${theme}: wide, stable, scrollable results and aligned actions`, async () => {
          await page.viewport(width, 800)
          setFontSize(font)
          setTheme(theme)
          const provider =
            theme === 'dark' && width === 1024
              ? 'chatgpt'
              : theme === 'dark' && width === 1280
                ? 'llamacpp-upstream'
                : 'A very long custom model provider name for local inference'
          useModelProvider.setState({
            selectedProvider: provider,
            providers: [
              {
                provider,
                active: true,
                models: [{ id: repo, capabilities: [] }],
                settings: [],
              },
            ] as unknown as ModelProvider[],
          })
          let resolve!: (models: CatalogModel[]) => void
          const pendingSearch = new Promise<CatalogModel[]>((done) => {
            resolve = done
          })
          search.mockImplementation(
            (_query: string, _token: string, _limit: number, format: string) =>
              pendingSearch.then((models) =>
                models.filter((model) => model.is_mlx === (format === 'mlx'))
              )
          )
          render(
            withTranslations(
              <div
                style={{
                  position: 'fixed',
                  bottom: 24,
                  right: 24,
                  left: width > 600 ? 280 : 16,
                }}
              >
                <DropdownModelProvider />
              </div>
            )
          )
          fireEvent.click(
            document.querySelector('[data-test-id="model-picker-trigger"]')!
          )
          const input = screen.getByPlaceholderText('Search models...')
          const panel = input.closest(
            '[data-slot="popover-content"]'
          ) as HTMLElement
          await settle(panel)
          await settle(panel)
          const bounds = panel.getBoundingClientRect()
          expect(bounds.width).toBeGreaterThanOrEqual(
            Math.min(600, width - 32) - 1
          )
          expect(bounds.left).toBeGreaterThanOrEqual(8)
          expect(bounds.right).toBeLessThanOrEqual(width - 8)
          const title = within(panel).getByTitle(getProviderTitle(provider))
          if (width >= 1024)
            expect(title.clientWidth).toBeGreaterThanOrEqual(title.scrollWidth)
          const gear = title.parentElement!.parentElement!
            .lastElementChild as HTMLElement
          const dot = title.parentElement!.querySelector('.rounded-full')!
          expect(
            gear.getBoundingClientRect().left -
              dot.getBoundingClientRect().right
          ).toBeGreaterThanOrEqual(12)
          expect(getComputedStyle(gear).backgroundColor).toBe(
            'rgba(0, 0, 0, 0)'
          )
          await userEvent.hover(gear)
          expect(getComputedStyle(gear).backgroundColor).not.toBe(
            'rgba(0, 0, 0, 0)'
          )
          await userEvent.unhover(gear)
          await waitFor(() =>
            expect(getComputedStyle(gear).backgroundColor).toBe(
              'rgba(0, 0, 0, 0)'
            )
          )
          // Tab enters keyboard modality; focus the provider gear in that modality.
          await userEvent.tab()
          gear.focus()
          expect(gear.matches(':focus-visible')).toBe(true)
          expect(getComputedStyle(gear).backgroundColor).not.toBe(
            'rgba(0, 0, 0, 0)'
          )
          gear.blur()
          expectNoHorizontalOverflow(panel)
          fireEvent.change(input, { target: { value: 'qwen' } })
          await waitFor(() => expect(resolve).toBeTypeOf('function'))
          const pending = panel.getBoundingClientRect()
          await act(async () =>
            resolve(
              Array.from({ length: 12 }, (_, i) => ({
                ...candidate(i % 2 === 1),
                model_name: `${repo}-${Math.floor(i / 2)}`,
              }))
            )
          )
          await waitFor(() =>
            expect(
              screen.getAllByTestId('model-picker-download-row')
            ).toHaveLength(12)
          )
          await settle(panel)
          expect(panel.getBoundingClientRect().height).toBeCloseTo(
            pending.height,
            0
          )
          expect(panel.getBoundingClientRect().top).toBeCloseTo(pending.top, 0)
          expectSameWidth([
            panel,
            { getBoundingClientRect: () => bounds } as Element,
          ])
          const rows = screen.getAllByTestId('model-picker-download-row')
          expect(
            rows.map((row) => within(row).getByText(/^(GGUF|MLX)$/).textContent)
          ).toEqual(
            Array.from({ length: 12 }, (_, i) => (i % 2 ? 'MLX' : 'GGUF'))
          )
          const actions = rows.map((row) => within(row).getByRole('button'))
          expectSameWidth(actions)
          expect(
            new Set(
              actions.map((button) =>
                Math.round(button.getBoundingClientRect().right)
              )
            ).size
          ).toBe(1)
          expectNoHorizontalOverflow(panel)
          const scroller = rows[0].closest('.overflow-y-auto') as HTMLElement
          expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight)
          scroller.scrollTop = scroller.scrollHeight
          expect(scroller.scrollTop).toBeGreaterThan(0)
        })
      }
    }
  }
})

for (const width of [1024, 390]) {
  for (const theme of ['light', 'dark'] as const) {
    it(`empty selector ${width}px ${theme}: reserves search geometry and scrolls both formats`, async () => {
      await page.viewport(width, 800)
      setFontSize(XL_FONT_SIZE)
      setTheme(theme)
      vi.spyOn(i18n, 't').mockImplementation((key, options) =>
        key === 'chat:replyGate.download'
          ? 'Herunterladen'
          : translate(key, options)
      )
      useModelProvider.setState({
        providers: [
          {
            provider: 'llamacpp-upstream',
            active: true,
            models: [],
            settings: [],
          },
        ] as unknown as ModelProvider[],
      })
      let resolve!: (models: CatalogModel[]) => void
      const pending = new Promise<CatalogModel[]>((done) => {
        resolve = done
      })
      search.mockImplementation(
        (_query: string, _token: string, _limit: number, format: string) =>
          pending.then((models) =>
            models.filter((model) => model.is_mlx === (format === 'mlx'))
          )
      )
      render(
        withTranslations(
          <div style={{ position: 'fixed', bottom: 24, right: 24 }}>
            <DropdownModelProvider />
          </div>
        )
      )
      fireEvent.click(
        document.querySelector('[data-test-id="model-picker-trigger"]')!
      )
      const input = screen.getByPlaceholderText('Search models...')
      const panel = input.closest(
        '[data-slot="popover-content"]'
      ) as HTMLElement
      await settle(panel)
      await settle(panel)
      fireEvent.change(input, { target: { value: 'qwen' } })
      const card = screen.getByTestId('model-picker-hugging-face')
      const routes = screen.getByTestId('model-picker-routes')
      const before = card.getBoundingClientRect()
      const routesTop = routes.getBoundingClientRect().top
      await act(async () =>
        resolve(
          Array.from({ length: 12 }, (_, i) => ({
            ...candidate(i % 2 === 1),
            model_name: `${repo}-${Math.floor(i / 2)}`,
          }))
        )
      )
      await waitFor(() =>
        expect(
          screen.getAllByTestId('model-picker-hugging-face-row')
        ).toHaveLength(12)
      )
      await settle(panel)
      expect(card.getBoundingClientRect().height).toBe(before.height)
      expect(routes.getBoundingClientRect().top).toBe(routesTop)
      expect(card.scrollHeight).toBeGreaterThan(card.clientHeight)
      expectSameWidth(
        screen
          .getAllByTestId('model-picker-hugging-face-row')
          .map((row) => within(row).getByRole('button'))
      )
      const rows = screen.getAllByTestId('model-picker-hugging-face-row')
      fireEvent.click(within(rows[0]).getByRole('button'))
      await waitFor(() =>
        expect(
          within(rows[0]).getByRole('button', { name: 'Cancel download' })
            .textContent
        ).toBe('Cancel')
      )
      act(() =>
        useDownloadStore.setState({
          downloads: {
            'layout-Q4_K_M': {
              id: 'layout-Q4_K_M',
              name: 'layout-Q4_K_M',
              progress: 1,
              current: 19.7 * 1024 ** 3,
              total: 19.7 * 1024 ** 3,
              speed: { bytesPerSecond: 0 },
            },
          } as never,
        })
      )
      const progress = within(rows[0]).getByText(/100%.*19.7/)
      expectOneLine(progress)
      expectSameWidth(rows.map((row) => within(row).getByRole('button')))
      expectNoHorizontalOverflow(panel)
    })
  }
}

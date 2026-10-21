import { act, fireEvent, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useMediaCatalog } from '@/stores/media-catalog-store'
import {
  DEFAULT_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  expectSameHeight,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'

import { CloudPage } from '../index'

const { searchState } = vi.hoisted(() => ({
  searchState: { current: {} as { provider?: string } },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: unknown) => config,
  redirect: (options: unknown) => options,
  useNavigate: () => vi.fn(),
  useRouter: () => ({ navigate: vi.fn() }),
  useSearch: () => searchState.current,
}))

const serviceHubStub = {
  providers: () => ({
    updateSettings: vi.fn().mockResolvedValue(undefined),
    // The add-model dialog suggests the provider's own list.
    fetchModelsFromProvider: vi.fn().mockResolvedValue([]),
  }),
  auth: () => ({
    chatgptStatus: vi.fn().mockResolvedValue({ connected: false }),
    chatgptCancelLogin: vi.fn().mockResolvedValue(undefined),
    chatgptModels: vi.fn().mockResolvedValue([]),
  }),
}
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => serviceHubStub,
  getServiceHub: () => serviceHubStub,
}))

// The real store fetches the registry on import; the catalogue is not what
// is measured here.
vi.mock('@/stores/provider-registry-store', () => {
  const state = {
    status: 'idle',
    fetchedAt: null,
    hasInitialized: false,
    error: null,
    refresh: () => {},
  }
  return {
    useProviderRegistryStore: Object.assign(
      (selector?: (s: unknown) => unknown) =>
        selector ? selector(state) : state,
      { getState: () => state }
    ),
    isKnownProvider: () => true,
  }
})

const setting = (key: string, value: string): ProviderSetting => ({
  key,
  title: key,
  description:
    key === 'api-key'
      ? 'Visit your [API keys](https://example.test) page to create one.'
      : '',
  controller_type: 'input',
  controller_props: { value, placeholder: '' },
})

/** A worst-case model id: an aggregator's vendor path with a long name. */
const LONG_MODEL =
  'meta-llama/llama-4-maverick-17b-128e-instruct-fp8-extended-context-preview'

const hosted = (
  provider: string,
  models: string[],
  api_key = ''
): ProviderObject => ({
  provider,
  active: true,
  models: models.map(
    (id) => ({ id, capabilities: ['completion', 'tools'] }) as Model
  ),
  settings: [
    setting('api-key', api_key),
    setting('base-url', `https://${provider}.example.test/v1`),
  ],
  api_key,
  base_url: `https://${provider}.example.test/v1`,
})

const providers: ProviderObject[] = [
  hosted(
    'openai',
    ['gpt-5.4', 'gpt-5.4-mini', LONG_MODEL.split('/')[1]],
    'sk-live'
  ),
  hosted('anthropic', ['claude-sonnet-5', 'claude-opus-5']),
  hosted('gemini', ['gemini-3-pro']),
  hosted('openrouter', [
    'openai/gpt-5.4',
    LONG_MODEL,
    'anthropic/claude-sonnet-5',
  ]),
  hosted('deepseek', ['deepseek-v4']),
  hosted('groq', [LONG_MODEL]),
  hosted('mistral', ['mistral-large-3']),
  hosted('xai', ['grok-5']),
  { provider: 'chatgpt', active: true, models: [], settings: [] },
]

const CASES = [1024, 1280].flatMap((width) =>
  [
    { fontSize: DEFAULT_FONT_SIZE, theme: 'light' as const },
    { fontSize: XL_FONT_SIZE, theme: 'dark' as const },
  ].map((style) => ({ width, ...style }))
)

/** The page in the app's column: beside the 60 px rail and 256 px sidebar. */
async function renderPage() {
  const view = render(
    withTranslations(
      <div className="flex h-[800px] w-full overflow-hidden">
        <aside className="w-[316px] shrink-0">Sidebar</aside>
        <main data-testid="page" className="min-w-0 flex-1">
          <CloudPage />
        </main>
      </div>
    )
  )
  await act(async () => {
    await settle(view.container)
  })
  return screen.getByTestId('page')
}

describe('Cloud providers page geometry', () => {
  beforeEach(() => {
    searchState.current = { provider: 'openai' }
    useModelProvider.setState({ providers })
    useMediaCatalog.setState({ available: false, status: 'ready' })
  })

  it.each(CASES)(
    'keeps both panes inside the column at $width px / $fontSize / $theme',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 800)
      setTheme(theme)
      setFontSize(fontSize)
      useGeneralSetting.setState({ cloudGuideDone: true })
      const root = await renderPage()

      expectNoHorizontalOverflow(root)
      const catalog = screen.getByRole('complementary', {
        name: 'Cloud catalog',
      })
      for (const row of catalog.querySelectorAll('button[aria-pressed]')) {
        expectOneLine(row.querySelector('span > span') as HTMLElement)
      }

      // A search that lists long ids across providers still fits.
      fireEvent.change(
        screen.getByRole('textbox', {
          name: 'Search cloud models or providers',
        }),
        { target: { value: 'llama' } }
      )
      await act(async () => {
        await settle(root)
      })
      // OpenAI, OpenRouter and Groq name it differently.
      expect(
        screen.getByText('Available through 3 providers')
      ).toBeInTheDocument()
      expectNoHorizontalOverflow(root)
      for (const heading of catalog.querySelectorAll('h3')) {
        expectOneLine(heading as HTMLElement)
      }
    }
  )

  it.each(CASES)(
    'lays the guide out in even cards at $width px / $fontSize / $theme',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 800)
      setTheme(theme)
      setFontSize(fontSize)
      // Nothing connected and the guide never finished: it opens.
      useModelProvider.setState({
        providers: providers.map((p) => ({ ...p, api_key: '' })),
      })
      useGeneralSetting.setState({ cloudGuideDone: false })
      const root = await renderPage()

      const guide = screen.getByRole('region', {
        name: 'Cloud provider setup',
      })
      expectNoHorizontalOverflow(root)
      const choices = [
        ...guide.querySelectorAll('button[aria-label^="Choose"]'),
      ]
      expect(choices.length).toBe(9)
      expectSameHeight(choices)
    }
  )
})

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelProvider } from '@/hooks/useModelProvider'
import { useEndpointCheckStore } from '@/stores/endpoint-check-store'
import { useMediaCatalog } from '@/stores/media-catalog-store'
import {
  DEFAULT_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'

import { EndpointsPage } from '../index'

const { searchState } = vi.hoisted(() => ({
  searchState: { current: {} as { provider?: string } },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: unknown) => config,
  useNavigate: () => vi.fn(),
  useRouter: () => ({ navigate: vi.fn() }),
  useSearch: () => searchState.current,
}))

const serviceHubStub = {
  providers: () => ({
    updateSettings: vi.fn().mockResolvedValue(undefined),
    fetchModelsFromProvider: vi.fn().mockResolvedValue([]),
    checkProviderEndpoint: vi.fn(),
  }),
}
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => serviceHubStub,
  getServiceHub: () => serviceHubStub,
}))

// Registry-shipped servers; the rest were added by the user. The real store
// fetches the registry on import.
vi.mock('@/stores/provider-registry-store', () => {
  const known = ['ollama', 'llamacpp-server', 'automatic1111']
  const state = {
    status: 'idle',
    hasInitialized: true,
    providers: known.map((provider) => ({ provider })),
    error: null,
  }
  return {
    useProviderRegistryStore: Object.assign(
      (selector?: (s: unknown) => unknown) =>
        selector ? selector(state) : state,
      { getState: () => state }
    ),
    isKnownProvider: (name: string) => known.includes(name),
  }
})

const setting = (key: string, value: string): ProviderSetting => ({
  key,
  title: key,
  description: '',
  controller_type: 'input',
  controller_props: { value, placeholder: '' },
})

/** A worst-case address and name: a LAN box behind a long path. */
const LONG_URL =
  'http://inference-gateway.internal.example.corp:18080/openai/compatible/v1'
const LONG_NAME = 'gpu-workstation-under-the-desk-with-a-very-long-name'

const server = (
  provider: string,
  base_url: string,
  extra: Partial<ProviderObject> = {}
): ProviderObject => ({
  provider,
  active: true,
  models: [],
  settings: [setting('base-url', base_url), setting('api-key', '')],
  base_url,
  ...extra,
})

const providers: ProviderObject[] = [
  server('ollama', 'http://localhost:11434/v1'),
  server('llamacpp-server', 'http://localhost:8080/v1'),
  server('automatic1111', 'http://127.0.0.1:7860', { media_only: true }),
  server(LONG_NAME, LONG_URL, {
    api_key: 'sk-lan',
    models: [
      {
        id: 'Qwen3-Coder-480B-A35B-Instruct-GGUF-UD-Q4_K_XL-extended',
        capabilities: ['completion', 'tools', 'vision'],
      } as Model,
      { id: 'llama3' } as Model,
    ],
  }),
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
      <div className="flex h-[900px] w-full overflow-hidden">
        <aside className="w-[316px] shrink-0">Sidebar</aside>
        <main data-testid="page" className="min-w-0 flex-1">
          <EndpointsPage />
        </main>
      </div>
    )
  )
  await act(async () => {
    await settle(view.container)
  })
  return screen.getByTestId('page')
}

describe('Custom Endpoint page geometry', () => {
  beforeEach(() => {
    searchState.current = {}
    useModelProvider.setState({ providers })
    useMediaCatalog.setState({ available: false, status: 'ready' })
    useEndpointCheckStore.setState({
      checking: {},
      results: {
        // A failure message as long as the ones the service writes.
        'ollama': {
          ok: false,
          latencyMs: 8000,
          modelCount: 0,
          message:
            'Cannot connect to ollama at http://localhost:11434/v1. Check that the server is running and the address is correct.',
        },
        'llamacpp-server': { ok: true, latencyMs: 24, modelCount: 12 },
      },
    })
  })

  it.each(CASES)(
    'keeps every row and its actions inside the column at $width px / $fontSize / $theme',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 900)
      setTheme(theme)
      setFontSize(fontSize)
      searchState.current = { provider: LONG_NAME }
      const root = await renderPage()

      expectNoHorizontalOverflow(root)
      const rows = screen.getAllByRole('article')
      expect(rows).toHaveLength(4)
      for (const row of rows) {
        // Name and address truncate rather than push the actions away.
        expectOneLine(row.querySelector('h2') as HTMLElement)
        expectOneLine(row.querySelector('h2 + p') as HTMLElement)
      }
      // The action column is one column: every row's Configure ends at the
      // same x, with or without something to remove.
      const configureEdges = rows.map(
        (row) =>
          within(row)
            .getByRole('button', { name: /^Configure / })
            .getBoundingClientRect().right
      )
      for (const edge of configureEdges) {
        expect(Math.abs(edge - configureEdges[0])).toBeLessThanOrEqual(1)
      }
    }
  )

  it.each(CASES)(
    'keeps the dialog inside itself with an error showing at $width px / $fontSize / $theme',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 900)
      setTheme(theme)
      setFontSize(fontSize)
      await renderPage()

      fireEvent.click(screen.getByRole('button', { name: 'Add New Endpoint' }))
      fireEvent.change(screen.getByPlaceholderText('My local server'), {
        target: { value: LONG_NAME },
      })
      fireEvent.change(screen.getByLabelText('Base URL'), {
        target: { value: 'not a url' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Save endpoint' }))
      const dialog = screen.getByRole('dialog')
      await act(async () => {
        await settle(dialog)
      })

      expect(within(dialog).getByRole('alert')).toBeInTheDocument()
      expectNoHorizontalOverflow(dialog)
    }
  )
})

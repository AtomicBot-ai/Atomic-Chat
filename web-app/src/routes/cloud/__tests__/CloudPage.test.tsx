import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CloudPage, Route } from '../index'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'

const {
  navigate,
  searchState,
  storeProviders,
  saveProviderApiKey,
  refreshProviderModels,
  auth,
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  searchState: { current: {} as { provider?: string; add?: 'custom' } },
  storeProviders: { current: [] as ProviderObject[] },
  saveProviderApiKey: vi.fn(),
  refreshProviderModels: vi.fn().mockResolvedValue(undefined),
  auth: {
    chatgptStatus: vi.fn().mockResolvedValue({ connected: false }),
    chatgptLogin: vi.fn(),
    chatgptCancelLogin: vi.fn().mockResolvedValue(undefined),
    chatgptLogout: vi.fn(),
    chatgptModels: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: unknown) => config,
  redirect: (options: unknown) => ({ redirect: options }),
  useNavigate: () => navigate,
  useSearch: () => searchState.current,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.provider ? `${key}:${String(options.provider)}` : key,
  }),
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

vi.mock('@/containers/ProvidersAvatar', () => ({
  default: ({ provider }: { provider: { provider: string } }) => (
    <span data-testid={`avatar-${provider.provider}`} />
  ),
}))

vi.mock('@/containers/RenderMarkdown', () => ({
  RenderMarkdown: ({ content }: { content: string }) => <span>{content}</span>,
}))

vi.mock('@/containers/dialogs/DeleteProvider', () => ({
  default: () => null,
}))

vi.mock('@/containers/dialogs/AddModel', () => ({
  DialogAddModel: () => <button>add-model</button>,
}))

vi.mock('@/containers/dialogs/EditModel', () => ({
  DialogEditModel: () => null,
}))

vi.mock('@/containers/dialogs/DeleteModel', () => ({
  DialogDeleteModel: () => null,
}))

vi.mock('@/containers/FavoriteModelAction', () => ({
  FavoriteModelAction: () => null,
}))

vi.mock('@/lib/provider-api-key', async () => {
  const actual = await vi.importActual<typeof import('@/lib/provider-api-key')>(
    '@/lib/provider-api-key'
  )
  return { ...actual, saveProviderApiKey }
})

vi.mock('@/lib/refresh-provider-models', () => ({ refreshProviderModels }))

vi.mock('@/utils/localApiServerControl', () => ({
  getLocalApiServerUrl: () => 'http://127.0.0.1:1337/v1',
}))

// One stable object: a fresh literal per render would re-run every effect that
// depends on the hub, which is not how the real store behaves.
const serviceHubStub = {
  providers: () => ({
    updateSettings: vi.fn().mockResolvedValue(undefined),
    // Connect asks the provider for its models with the key first.
    checkProviderEndpoint: vi
      .fn()
      .mockResolvedValue({ ok: true, latencyMs: 1, modelCount: 2 }),
  }),
  auth: () => auth,
}

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => serviceHubStub,
}))

// The subscription card is desktop-only; force it on so its states are
// exercised here rather than only on a Tauri build.
vi.mock('@/lib/platform/const', () => ({
  PlatformFeatures: new Proxy({}, { get: () => true }),
}))

vi.mock('@/stores/provider-registry-store', () => ({
  useProviderRegistryStore: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      const state = {
        status: 'idle',
        fetchedAt: null,
        refresh: vi.fn(),
        error: null,
      }
      return selector ? selector(state) : state
    },
    { getState: () => ({ error: null }) }
  ),
  isKnownProvider: (name: string) => name !== 'my-custom',
}))

vi.mock('@/hooks/useModelProvider', () => {
  const hook = vi.fn()
  // The subscription hook reaches the store directly to write its model list.
  Object.assign(hook, {
    getState: () => ({
      getProviderByName: (name: string) =>
        storeProviders.current.find((p) => p.provider === name),
      updateProvider: vi.fn(),
    }),
  })
  return { useModelProvider: hook }
})

const apiKeySetting: ProviderSetting = {
  key: 'api-key',
  title: 'API Key',
  description: 'Visit your [API Keys](https://example.test) page.',
  controller_type: 'input',
  controller_props: { value: '', type: 'password', placeholder: 'sk-…' },
}

const baseUrlSetting: ProviderSetting = {
  key: 'base-url',
  title: 'Base URL',
  description: '',
  controller_type: 'input',
  controller_props: { value: 'https://api.openai.com/v1' },
}

const providers: ProviderObject[] = [
  {
    provider: 'llamacpp-upstream',
    active: true,
    models: [],
    settings: [],
    persist: true,
  },
  {
    // Signed in with a ChatGPT account: no key, no settings, models arrive on
    // sign-in. Its card only renders while it is the selected provider.
    provider: 'chatgpt',
    active: true,
    models: [],
    settings: [],
    base_url: 'https://chatgpt.com/backend-api/codex',
  },
  {
    provider: 'openai',
    active: true,
    models: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4-mini' }],
    settings: [apiKeySetting, baseUrlSetting],
    base_url: 'https://api.openai.com/v1',
  },
  {
    provider: 'ollama',
    active: true,
    models: [],
    settings: [],
    base_url: 'http://localhost:11434/v1',
  },
]

const updateProvider = vi.fn()

/** The right pane: the selected provider's connection and models. */
const configuration = () =>
  screen.getByRole('region', { name: 'cloud:configurationLabel' })

const mockStore = (list: ProviderObject[] = providers) => {
  storeProviders.current = list
  vi.mocked(useModelProvider).mockReturnValue({
    providers: list,
    addProvider: vi.fn(),
    updateProvider,
    setProviders: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

describe('CloudPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchState.current = {}
    // The first-visit guide has its own cases below.
    useGeneralSetting.setState({ cloudGuideDone: true })
    auth.chatgptStatus.mockResolvedValue({ connected: false })
    auth.chatgptCancelLogin.mockResolvedValue(undefined)
    auth.chatgptModels.mockResolvedValue([])
    mockStore()
  })

  it('renders the subscription card only while its provider is selected', () => {
    searchState.current = { provider: 'openai' }
    const { unmount } = render(<CloudPage />)

    expect(within(configuration()).getByText('OpenAI')).toBeInTheDocument()
    expect(
      screen.queryByText('cloud:subscription.title')
    ).not.toBeInTheDocument()
    unmount()

    searchState.current = { provider: 'chatgpt' }
    render(<CloudPage />)

    expect(screen.getByText('cloud:subscription.title')).toBeInTheDocument()
    // The connection card keeps its title but hands the body to the
    // subscription card — no second, always-"not connected" status line.
    expect(
      within(configuration()).getByText('ChatGPT subscription (Codex)')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('cloud:connection.routing')
    ).not.toBeInTheDocument()
  })

  it('offers browser sign-in as the only way in', async () => {
    searchState.current = { provider: 'chatgpt' }
    render(<CloudPage />)
    await waitFor(() =>
      expect(auth.chatgptStatus.mock.calls.length).toBeGreaterThan(0)
    )

    expect(
      screen.getByText('cloud:subscription.connectInBrowser').closest('button')
    ).toBeEnabled()
    // The device-code button is gone: the grant is not implemented and no
    // caller ever passed a handler, so it only ever rendered dead.
    expect(
      screen.queryByText('cloud:subscription.useDeviceCode')
    ).not.toBeInTheDocument()
  })

  it('shows the connected account once signed in', async () => {
    searchState.current = { provider: 'chatgpt' }
    auth.chatgptStatus.mockResolvedValueOnce({
      connected: true,
      email: 'user@example.test',
      plan_type: 'Plus',
    })
    render(<CloudPage />)

    expect(
      await screen.findByText('user@example.test (Plus)')
    ).toBeInTheDocument()
    expect(screen.getByText('cloud:connection.disconnect')).toBeInTheDocument()
  })

  it('surfaces the backend message when sign-in fails', async () => {
    searchState.current = { provider: 'chatgpt' }
    auth.chatgptLogin.mockRejectedValueOnce(
      new Error('cannot listen on 127.0.0.1:1455 for the sign-in callback')
    )
    render(<CloudPage />)
    await waitFor(() =>
      expect(auth.chatgptStatus.mock.calls.length).toBeGreaterThan(0)
    )

    fireEvent.click(screen.getByText('cloud:subscription.connectInBrowser'))

    expect(
      await screen.findByText(
        'cannot listen on 127.0.0.1:1455 for the sign-in callback'
      )
    ).toBeInTheDocument()
  })

  it('lists hosted providers only: self-hosted servers live on Custom Endpoint', () => {
    // `ollama` answered with a model, so it is connected — and still not here,
    // nor is the page opened on it.
    mockStore(
      providers.map((p) =>
        p.provider === 'ollama'
          ? { ...p, models: [{ id: 'llama3' } as Model] }
          : p
      )
    )
    render(<CloudPage />)

    const catalog = screen.getByRole('complementary', {
      name: 'cloud:browser.label',
    })
    expect(
      within(catalog).getByRole('button', {
        name: 'cloud:browser.configure:OpenAI',
      })
    ).toBeInTheDocument()
    expect(
      within(catalog).queryByRole('button', {
        name: 'cloud:browser.configure:Ollama',
      })
    ).not.toBeInTheDocument()
    expect(
      within(catalog).queryByRole('button', {
        name: 'cloud:browser.configure:llama.cpp',
      })
    ).not.toBeInTheDocument()
    expect(
      within(configuration()).queryByText('Ollama')
    ).not.toBeInTheDocument()
  })

  it('pins the implicit connected provider in the URL before it can disconnect', async () => {
    const openai = providers.find((p) => p.provider === 'openai')!
    mockStore([
      ...providers.filter((p) => p.provider !== 'openai'),
      { ...openai, api_key: 'sk-live' },
    ])
    const { rerender } = render(<CloudPage />)
    // It opens on the connected key, not on a provider still to set up.
    expect(screen.getByText('cloud:connection.disconnect')).toBeInTheDocument()

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: '/cloud/',
        search: { provider: 'openai' },
        replace: true,
      })
    )

    // Follow the router to the pinned URL, then take the key away: the page
    // stays on OpenAI, now offering to connect it, instead of jumping to
    // whichever provider comes first once nothing is connected.
    searchState.current = navigate.mock.calls[0][0].search
    mockStore(providers)
    rerender(<CloudPage />)
    expect(
      screen.getByText('cloud:connection.notConnected')
    ).toBeInTheDocument()
    expect(
      screen.getByDisplayValue('https://api.openai.com/v1')
    ).toBeInTheDocument()
    expect(screen.getByText('providers:models')).toBeInTheDocument()
  })

  // The sidebar's Custom Endpoint row used to link here with `?add=custom`.
  it('forwards the old custom endpoint link and self-hosted providers to Custom Endpoint', () => {
    const beforeLoad = (
      Route as unknown as {
        beforeLoad: (ctx: { search: Record<string, string> }) => void
      }
    ).beforeLoad
    const thrown = (search: Record<string, string>) => {
      try {
        beforeLoad({ search })
      } catch (error) {
        return error
      }
      return undefined
    }

    expect(thrown({ add: 'custom' })).toEqual({
      redirect: { to: '/endpoints/' },
    })
    // Where `/settings/providers/ollama` and the model picker's gear send it.
    expect(thrown({ provider: 'ollama' })).toEqual({
      redirect: { to: '/endpoints/', search: { provider: 'ollama' } },
    })
    expect(thrown({ provider: 'openai' })).toBeUndefined()
    expect(thrown({})).toBeUndefined()
  })

  it('opens on OpenRouter when nothing is connected and the URL names none', () => {
    // A blank picker on arrival is a dead page. With no connection to open
    // on, the page still lands on a provider the user can set up right away.
    mockStore([
      ...providers,
      {
        provider: 'openrouter',
        active: true,
        models: [],
        settings: [apiKeySetting, baseUrlSetting],
        api_key: '',
        base_url: 'https://openrouter.ai/api/v1',
      },
    ])
    render(<CloudPage />)

    expect(
      screen.queryByText('cloud:connection.placeholder')
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('cloud:connection.notConnected')
    ).toBeInTheDocument()
    expect(
      screen.getByDisplayValue('https://openrouter.ai/api/v1')
    ).toBeInTheDocument()
  })

  it('falls back to the first cloud provider when OpenRouter is not in the catalog', () => {
    // Nothing here has a key, and the keyless Ollama has never answered.
    mockStore()
    render(<CloudPage />)

    expect(
      screen.queryByText('cloud:connection.placeholder')
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('cloud:connection.notConnected')
    ).toBeInTheDocument()
  })

  it('opens on the provider named in the URL', () => {
    searchState.current = { provider: 'openai' }
    render(<CloudPage />)

    expect(screen.getByText('providers:models')).toBeInTheDocument()
    expect(
      within(configuration()).getByText('cloud:models.count')
    ).toBeInTheDocument()
  })

  it('writes the key to both the settings entry and the mirror', async () => {
    searchState.current = { provider: 'openai' }
    render(<CloudPage />)

    fireEvent.change(screen.getByPlaceholderText('sk-…'), {
      target: { value: '  sk-live  ' },
    })
    fireEvent.click(screen.getByText('cloud:connection.connect'))

    await waitFor(() => expect(saveProviderApiKey).toHaveBeenCalled())
    const call = vi.mocked(saveProviderApiKey).mock.calls[0][0]
    expect(call.apiKey).toBe('sk-live')
    expect(call.provider.provider).toBe('openai')
  })

  it('trims the base URL before storing it', () => {
    searchState.current = { provider: 'openai' }
    render(<CloudPage />)

    fireEvent.change(screen.getByDisplayValue('https://api.openai.com/v1'), {
      target: { value: ' https://proxy.test/v1 ' },
    })

    const [name, patch] = updateProvider.mock.calls[0]
    expect(name).toBe('openai')
    expect(patch.base_url).toBe('https://proxy.test/v1')
    // The settings entry is normalised too, not just the mirror.
    expect(
      patch.settings.find((s: ProviderSetting) => s.key === 'base-url')
        ?.controller_props.value
    ).toBe('https://proxy.test/v1')
  })

  it('clears the key on disconnect', () => {
    searchState.current = { provider: 'openai' }
    const openai = providers.find((p) => p.provider === 'openai')!
    mockStore([
      ...providers.filter((p) => p.provider !== 'openai'),
      { ...openai, api_key: 'sk-live' },
    ])
    render(<CloudPage />)

    fireEvent.click(screen.getByText('cloud:connection.disconnect'))
    fireEvent.click(
      screen.getAllByText('cloud:connection.disconnect').slice(-1)[0]
    )

    const [name, patch] = updateProvider.mock.calls[0]
    expect(name).toBe('openai')
    expect(patch.api_key).toBe('')
    expect(
      patch.settings.find((s: ProviderSetting) => s.key === 'api-key')
        ?.controller_props.value
    ).toBe('')
  })

  it('filters the model list', () => {
    searchState.current = { provider: 'openai' }
    render(<CloudPage />)

    fireEvent.change(
      screen.getByPlaceholderText('cloud:models.searchPlaceholder'),
      { target: { value: 'mini' } }
    )

    expect(screen.getByText('gpt-5.4-mini')).toBeInTheDocument()
    expect(screen.queryByText('gpt-5.4')).not.toBeInTheDocument()
  })

  it('reports no matches for an unknown search', () => {
    searchState.current = { provider: 'openai' }
    render(<CloudPage />)

    fireEvent.change(
      screen.getByPlaceholderText('cloud:models.searchPlaceholder'),
      { target: { value: 'zzz' } }
    )

    expect(screen.getByText('cloud:models.noResults')).toBeInTheDocument()
  })

  /**
   * The horizontal geometry of the page for one selected provider, as
   * rendered class strings: the scroll container, the centred column and
   * every card in it. jsdom does no layout, so the classes are the closest
   * thing to "where the content sits" a component test can pin down.
   */
  const renderedGeometry = (providerName: string) => {
    searchState.current = { provider: providerName }
    const { unmount } = render(<CloudPage />)
    const scroller = configuration()
    const column = scroller.querySelector('.max-w-3xl') as HTMLElement
    const geometry = {
      scroller: scroller.className,
      column: column.className,
      cards: Array.from(column.children, (card) => card.className),
    }
    unmount()
    return geometry
  }

  it('reserves the scrollbar gutter so the column stays put when the list overflows', () => {
    // A long model list scrolls and a short one does not, so every switch
    // between two such providers grew or shrank the scroll container by one
    // scrollbar and re-centred the column a few pixels sideways.
    const { scroller } = renderedGeometry('openai')

    expect(scroller).toContain('overflow-y-auto')
    expect(scroller).toContain('[scrollbar-gutter:stable]')
  })

  it('renders every provider kind in one column with identical card geometry', () => {
    mockStore([
      ...providers,
      ...['openrouter', 'anthropic', 'gemini'].map((provider) => ({
        provider,
        active: true,
        models: [],
        settings: [apiKeySetting, baseUrlSetting],
        api_key: '',
        base_url: `https://${provider}.test/v1`,
      })),
    ])
    const kinds = ['openrouter', 'anthropic', 'openai', 'gemini', 'chatgpt']
    const [reference, ...others] = kinds.map(renderedGeometry)

    expect(reference.column).toContain('mx-auto')
    expect(reference.column).toContain('max-w-3xl')
    // Every card is the same full-width Card — nothing is `w-fit`, nothing
    // carries a per-provider margin — so only heights may differ.
    expect(new Set(reference.cards).size).toBe(1)
    expect(reference.cards[0]).toContain('w-full')
    for (const geometry of others) {
      expect(geometry.scroller).toBe(reference.scroller)
      expect(geometry.column).toBe(reference.column)
      expect(new Set(geometry.cards)).toEqual(new Set(reference.cards))
    }
  })
})

describe('CloudPage guide and catalog', () => {
  const openrouter: ProviderObject = {
    provider: 'openrouter',
    active: true,
    models: [
      { id: 'openai/GPT-5.4' } as Model,
      { id: 'anthropic/claude-sonnet-5' } as Model,
    ],
    settings: [apiKeySetting, baseUrlSetting],
    api_key: '',
    base_url: 'https://openrouter.ai/api/v1',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    searchState.current = {}
    useGeneralSetting.setState({ cloudGuideDone: true })
    auth.chatgptStatus.mockResolvedValue({ connected: false })
    auth.chatgptCancelLogin.mockResolvedValue(undefined)
    auth.chatgptModels.mockResolvedValue([])
    mockStore([...providers, openrouter])
  })

  const guide = () =>
    screen.queryByRole('region', { name: 'cloud:guide.label' })

  it('opens the guide on a first visit with no hosted provider connected', () => {
    useGeneralSetting.setState({ cloudGuideDone: false })
    // A server of one's own answering does not make the cloud set up.
    mockStore([
      ...providers.map((p) =>
        p.provider === 'ollama'
          ? { ...p, models: [{ id: 'llama3' } as Model] }
          : p
      ),
      openrouter,
    ])
    render(<CloudPage />)

    expect(guide()).toBeInTheDocument()
    expect(
      screen.queryByRole('complementary', { name: 'cloud:browser.label' })
    ).not.toBeInTheDocument()
    // Flagships first, in the guide's order; never a self-hosted server.
    const choices = within(guide()!)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
      .filter((label) => label?.startsWith('cloud:guide.choose'))
    expect(choices).toEqual([
      'cloud:guide.choose:OpenAI',
      'cloud:guide.choose:OpenRouter',
      'cloud:guide.choose:ChatGPT subscription (Codex)',
    ])
  })

  it("walks from a choice to that provider's connection form, then finishes", () => {
    useGeneralSetting.setState({ cloudGuideDone: false })
    const { rerender } = render(<CloudPage />)

    fireEvent.click(
      screen.getByRole('button', { name: 'cloud:guide.choose:OpenRouter' })
    )
    expect(navigate).toHaveBeenCalledWith({
      to: '/cloud/',
      search: { provider: 'openrouter' },
      replace: true,
    })
    searchState.current = { provider: 'openrouter' }
    rerender(<CloudPage />)

    expect(screen.getByText('cloud:guide.stepConnect')).toBeInTheDocument()
    expect(
      screen.getByDisplayValue('https://openrouter.ai/api/v1')
    ).toBeInTheDocument()

    // The key lands and the guide says so, with a way out.
    mockStore([...providers, { ...openrouter, api_key: 'sk-or' }])
    rerender(<CloudPage />)
    expect(within(guide()!).getByRole('status')).toHaveTextContent(
      'cloud:guide.successTitle:OpenRouter'
    )

    fireEvent.click(
      within(within(guide()!).getByRole('status')).getByText('cloud:guide.done')
    )
    expect(guide()).not.toBeInTheDocument()
    expect(useGeneralSetting.getState().cloudGuideDone).toBe(true)
    expect(
      screen.getByRole('complementary', { name: 'cloud:browser.label' })
    ).toBeInTheDocument()
  })

  it('skips the guide when a provider is already connected, and reopens it on "Guide me"', () => {
    useGeneralSetting.setState({ cloudGuideDone: false })
    mockStore([...providers, { ...openrouter, api_key: 'sk-or' }])
    render(<CloudPage />)

    expect(guide()).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('cloud:guide.open'))
    expect(guide()).toBeInTheDocument()
    fireEvent.click(screen.getByText('cloud:guide.done'))
    expect(guide()).not.toBeInTheDocument()
  })

  it('shows each provider with its model count and connection', () => {
    mockStore([
      ...providers.map((p) =>
        p.provider === 'openai' ? { ...p, api_key: 'sk-live' } : p
      ),
      openrouter,
    ])
    render(<CloudPage />)

    const row = (name: string) =>
      screen.getByRole('button', { name: `cloud:browser.configure:${name}` })
    // The t() stub drops `count`, so the label key is what is checked.
    expect(row('OpenAI')).toHaveTextContent(
      'cloud:models.count · cloud:connection.connected'
    )
    expect(row('OpenRouter')).toHaveTextContent('cloud:models.count')
    expect(row('OpenRouter')).not.toHaveTextContent(
      'cloud:connection.connected'
    )
    expect(row('ChatGPT subscription (Codex)')).toHaveTextContent(
      'cloud:models.countNone'
    )
  })

  it('finds a model across providers and opens one of them for it', () => {
    searchState.current = { provider: 'openai' }
    const { rerender } = render(<CloudPage />)

    fireEvent.change(
      screen.getByRole('textbox', { name: 'cloud:browser.searchLabel' }),
      { target: { value: 'gpt-5.4' } }
    )

    // `gpt-5.4` and OpenRouter's `openai/GPT-5.4` are one model; `gpt-5.4-mini`
    // is another, on OpenAI alone.
    const catalog = screen.getByRole('complementary', {
      name: 'cloud:browser.label',
    })
    expect(
      within(catalog).getByText('cloud:browser.models')
    ).toBeInTheDocument()
    expect(
      within(catalog).getByText('cloud:browser.availableThrough')
    ).toBeInTheDocument()
    expect(
      within(catalog).getByText('cloud:browser.availableThroughOne')
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'cloud:browser.configureFor:OpenRouter',
      })
    )
    expect(navigate).toHaveBeenLastCalledWith({
      to: '/cloud/',
      search: { provider: 'openrouter' },
      replace: true,
    })
    searchState.current = { provider: 'openrouter' }
    rerender(<CloudPage />)
    expect(within(configuration()).getByRole('status')).toHaveTextContent(
      'gpt-5.4cloud:browser.modelConnect'
    )
  })

  /**
   * The pane a page too narrow for both shows. Which one is visible is CSS
   * (a container query) that jsdom does not apply; the layout suite measures
   * it in Chromium.
   */
  const pane = () =>
    document.querySelector('[data-pane]')?.getAttribute('data-pane')

  it('opens on the catalog from the sidebar, and on the configuration from a link naming a provider', () => {
    const { unmount } = render(<CloudPage />)
    expect(pane()).toBe('catalog')
    unmount()

    searchState.current = { provider: 'openrouter' }
    render(<CloudPage />)
    expect(pane()).toBe('configuration')
  })

  it('shows a picked provider in place of the catalog, and Back returns to it', () => {
    render(<CloudPage />)

    fireEvent.click(
      screen.getByRole('button', { name: 'cloud:browser.configure:OpenRouter' })
    )
    expect(pane()).toBe('configuration')
    expect(navigate).toHaveBeenLastCalledWith({
      to: '/cloud/',
      search: { provider: 'openrouter' },
      replace: true,
    })

    fireEvent.click(screen.getByRole('button', { name: 'cloud:browser.back' }))
    expect(pane()).toBe('catalog')
  })

  it('lands on the catalog when the guide is left', () => {
    useGeneralSetting.setState({ cloudGuideDone: false })
    searchState.current = { provider: 'openrouter' }
    render(<CloudPage />)

    fireEvent.click(screen.getByText('cloud:guide.browse'))
    expect(guide()).not.toBeInTheDocument()
    expect(pane()).toBe('catalog')
  })

  it('says so when nothing matches', () => {
    render(<CloudPage />)

    fireEvent.change(
      screen.getByRole('textbox', { name: 'cloud:browser.searchLabel' }),
      { target: { value: 'no-such-model' } }
    )

    expect(screen.getByText('cloud:browser.noResults')).toBeInTheDocument()
  })
})

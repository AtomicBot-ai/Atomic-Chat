import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EndpointsPage } from '../index'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useEndpointCheckStore } from '@/stores/endpoint-check-store'
import { useMediaCatalog } from '@/stores/media-catalog-store'
import { useProviderKeyStatusStore } from '@/stores/provider-key-status-store'

const {
  navigate,
  searchState,
  storeProviders,
  saveProviderApiKey,
  refreshProviderModels,
  registerRemoteProvider,
  checkProviderEndpoint,
  updateSettings,
  deleteProvider,
  connectMediaServer,
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  searchState: { current: {} as { provider?: string } },
  storeProviders: { current: [] as ProviderObject[] },
  saveProviderApiKey: vi.fn(),
  refreshProviderModels: vi.fn().mockResolvedValue(undefined),
  registerRemoteProvider: vi.fn().mockResolvedValue(true),
  checkProviderEndpoint: vi.fn(),
  updateSettings: vi.fn().mockResolvedValue(undefined),
  deleteProvider: vi.fn(),
  connectMediaServer: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: unknown) => config,
  useNavigate: () => navigate,
  useSearch: () => searchState.current,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const value = options?.name ?? options?.provider
      return value ? `${key}:${String(value)}` : key
    },
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

vi.mock('@/utils/registerRemoteProvider', async () => {
  const actual = await vi.importActual<
    typeof import('@/utils/registerRemoteProvider')
  >('@/utils/registerRemoteProvider')
  return { ...actual, registerRemoteProvider }
})

const serviceHubStub = {
  providers: () => ({ updateSettings, checkProviderEndpoint }),
}
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => serviceHubStub,
  getServiceHub: () => serviceHubStub,
}))

vi.mock('@/hooks/useDeleteProvider', () => ({
  canDeleteProvider: (provider?: ProviderObject) =>
    provider !== undefined && provider.provider === 'my-server',
  useDeleteProvider: () => deleteProvider,
}))

vi.mock('@/hooks/useConnectMediaServer', () => ({
  useConnectMediaServer: () => ({
    connecting: false,
    connect: connectMediaServer,
  }),
}))

/** What the catalogue ships; anything else was added by the user. */
const REGISTRY = [
  'openai',
  'chatgpt',
  'ollama',
  'llamacpp-server',
  'automatic1111',
]

vi.mock('@/stores/provider-registry-store', () => {
  const state = {
    status: 'idle',
    hasInitialized: true,
    providers: [
      'openai',
      'chatgpt',
      'ollama',
      'llamacpp-server',
      'automatic1111',
    ].map((provider) => ({ provider })),
    error: null,
  }
  return {
    useProviderRegistryStore: Object.assign(
      (selector?: (s: unknown) => unknown) =>
        selector ? selector(state) : state,
      { getState: () => state }
    ),
    isKnownProvider: (name: string) =>
      [
        'openai',
        'chatgpt',
        'ollama',
        'llamacpp-server',
        'automatic1111',
      ].includes(name),
  }
})

vi.mock('@/hooks/useModelProvider', () => {
  const hook = vi.fn()
  Object.assign(hook, {
    getState: () => ({
      getProviderByName: (name: string) =>
        storeProviders.current.find((p) => p.provider === name),
    }),
  })
  return { useModelProvider: hook }
})

const setting = (
  key: string,
  value: string,
  placeholder = ''
): ProviderSetting => ({
  key,
  title: key,
  description: '',
  controller_type: 'input',
  controller_props: { value, placeholder },
})

const providers: ProviderObject[] = [
  {
    provider: 'llamacpp-upstream',
    active: true,
    models: [],
    settings: [],
    persist: true,
  },
  {
    provider: 'openai',
    active: true,
    models: [{ id: 'gpt-5.4' } as Model],
    settings: [
      setting('api-key', ''),
      setting('base-url', 'https://api.openai.com/v1'),
    ],
    api_key: 'sk-openai',
    base_url: 'https://api.openai.com/v1',
  },
  { provider: 'chatgpt', active: true, models: [], settings: [] },
  {
    provider: 'ollama',
    active: true,
    models: [],
    settings: [
      setting(
        'base-url',
        'http://localhost:11434/v1',
        'http://localhost:11434/v1'
      ),
      setting('api-key', ''),
    ],
    base_url: 'http://localhost:11434/v1',
  },
  {
    provider: 'automatic1111',
    media_only: true,
    active: true,
    models: [],
    settings: [
      setting('base-url', 'http://127.0.0.1:7860'),
      setting('api-key', ''),
    ],
    base_url: 'http://127.0.0.1:7860',
  },
  {
    // Added by the user: a LAN box that wants a key.
    provider: 'my-server',
    active: true,
    models: [{ id: 'qwen3' } as Model, { id: 'llama3' } as Model],
    settings: [
      setting('api-key', 'sk-lan'),
      setting('base-url', 'http://192.168.1.20:8000/v1'),
    ],
    api_key: 'sk-lan',
    base_url: 'http://192.168.1.20:8000/v1',
  },
]

const addProvider = vi.fn((provider: ProviderObject) => {
  storeProviders.current = [...storeProviders.current, provider]
})
const updateProvider = vi.fn()
const setProviders = vi.fn()

const mockStore = (list: ProviderObject[] = providers) => {
  storeProviders.current = list
  vi.mocked(useModelProvider).mockReturnValue({
    providers: list,
    addProvider,
    updateProvider,
    setProviders,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

const card = (title: string) => screen.getByRole('article', { name: title })

describe('EndpointsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchState.current = {}
    useEndpointCheckStore.setState({ results: {}, checking: {} })
    useProviderKeyStatusStore.setState({ statuses: {} })
    // No media catalog from the core unless a case says otherwise.
    useMediaCatalog.setState({ available: false, status: 'ready' })
    mockStore()
  })

  it("lists the user's own servers and nothing hosted or local", () => {
    render(<EndpointsPage />)

    expect(
      screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))
    ).toEqual(['Ollama', 'Automatic1111 / Forge', 'My-server'])
    expect(screen.getByText('http://192.168.1.20:8000/v1')).toBeInTheDocument()
    expect(REGISTRY).not.toContain('my-server')
  })

  it('shows the empty state with nothing to list', () => {
    mockStore(
      providers.filter((p) => ['openai', 'chatgpt'].includes(p.provider))
    )
    render(<EndpointsPage />)

    expect(screen.getByText('endpoints:empty.title')).toBeInTheDocument()
    fireEvent.click(screen.getByText('endpoints:add'))
    expect(screen.getByText('endpoints:dialog.addTitle')).toBeInTheDocument()
  })

  it('reads the connection from the provider until a ping says otherwise', () => {
    render(<EndpointsPage />)

    expect(within(card('My-server')).getByRole('status')).toHaveTextContent(
      'endpoints:status.connected'
    )
    // Keyless and never answered with a model list: nothing is known yet.
    expect(within(card('Ollama')).getByRole('status')).toHaveTextContent(
      'endpoints:status.notChecked'
    )
  })

  it('pings an endpoint and keeps the answer for the session', async () => {
    checkProviderEndpoint.mockResolvedValueOnce({
      ok: true,
      latencyMs: 24,
      modelCount: 3,
    })
    render(<EndpointsPage />)

    fireEvent.click(within(card('Ollama')).getByText('endpoints:actions.ping'))

    await waitFor(() =>
      expect(within(card('Ollama')).getByRole('status')).toHaveTextContent(
        'endpoints:status.reachable'
      )
    )
    expect(checkProviderEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'ollama' })
    )
    expect(useEndpointCheckStore.getState().results.ollama).toEqual({
      ok: true,
      latencyMs: 24,
      modelCount: 3,
    })
    // A ping writes nothing to the provider.
    expect(updateProvider).not.toHaveBeenCalled()
  })

  it('says why a ping failed', async () => {
    checkProviderEndpoint.mockResolvedValueOnce({
      ok: false,
      latencyMs: 8000,
      modelCount: 0,
      message: 'Cannot connect to ollama at http://localhost:11434/v1.',
    })
    render(<EndpointsPage />)

    fireEvent.click(within(card('Ollama')).getByText('endpoints:actions.ping'))

    await waitFor(() =>
      expect(within(card('Ollama')).getByRole('status')).toHaveTextContent(
        'endpoints:status.failed · Cannot connect to ollama at http://localhost:11434/v1.'
      )
    )
  })

  it('adds an endpoint, then registers it and asks it for its models', async () => {
    checkProviderEndpoint.mockResolvedValueOnce({
      ok: true,
      latencyMs: 3,
      modelCount: 1,
    })
    render(<EndpointsPage />)

    fireEvent.click(screen.getByText('endpoints:add'))
    fireEvent.change(
      screen.getByPlaceholderText('endpoints:dialog.namePlaceholder'),
      { target: { value: '  lan-vllm ' } }
    )
    fireEvent.change(screen.getByLabelText('endpoints:dialog.baseUrl'), {
      target: { value: ' http://192.168.1.30:8000/v1 ' },
    })
    fireEvent.change(screen.getByLabelText('endpoints:dialog.apiKey'), {
      target: { value: 'sk-new' },
    })
    fireEvent.click(screen.getByText('endpoints:dialog.save'))

    // The server is asked, with the address and key as typed, before saving.
    await waitFor(() => expect(addProvider).toHaveBeenCalled())
    expect(checkProviderEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'lan-vllm',
        base_url: 'http://192.168.1.30:8000/v1',
        api_key: 'sk-new',
      })
    )
    const added = addProvider.mock.calls[0][0]
    expect(added).toMatchObject({
      provider: 'lan-vllm',
      base_url: 'http://192.168.1.30:8000/v1',
      api_key: '',
    })
    // The address is the user's, never OpenAI's default.
    expect(
      added.settings.find((s: ProviderSetting) => s.key === 'base-url')
        ?.controller_props.value
    ).toBe('http://192.168.1.30:8000/v1')
    expect(saveProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-new',
        provider: expect.objectContaining({ provider: 'lan-vllm' }),
      })
    )
    expect(navigate).toHaveBeenCalledWith({
      to: '/endpoints/',
      search: { provider: 'lan-vllm' },
      replace: true,
    })
    await waitFor(() => expect(refreshProviderModels).toHaveBeenCalled())
    expect(registerRemoteProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'lan-vllm' })
    )
    expect(refreshProviderModels.mock.calls[0][0].provider.provider).toBe(
      'lan-vllm'
    )
  })

  it('refuses a name in use and an address that is not HTTP', () => {
    render(<EndpointsPage />)

    fireEvent.click(screen.getByText('endpoints:add'))
    const name = screen.getByPlaceholderText('endpoints:dialog.namePlaceholder')
    const url = screen.getByLabelText('endpoints:dialog.baseUrl')

    fireEvent.change(name, { target: { value: 'OpenAI' } })
    fireEvent.change(url, { target: { value: 'http://192.168.1.30:8000' } })
    fireEvent.click(screen.getByText('endpoints:dialog.save'))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'common:providerAlreadyExists:OpenAI'
    )

    fireEvent.change(name, { target: { value: 'lan-vllm' } })
    fireEvent.change(url, { target: { value: 'ftp://192.168.1.30' } })
    fireEvent.click(screen.getByText('endpoints:dialog.save'))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'endpoints:dialog.invalidUrl'
    )
    expect(addProvider).not.toHaveBeenCalled()
  })

  const fillNewEndpoint = (baseUrl: string, apiKey = '') => {
    fireEvent.click(screen.getByText('endpoints:add'))
    fireEvent.change(
      screen.getByPlaceholderText('endpoints:dialog.namePlaceholder'),
      { target: { value: 'lan-vllm' } }
    )
    fireEvent.change(screen.getByLabelText('endpoints:dialog.baseUrl'), {
      target: { value: baseUrl },
    })
    fireEvent.change(screen.getByLabelText('endpoints:dialog.apiKey'), {
      target: { value: apiKey },
    })
    fireEvent.click(screen.getByText('endpoints:dialog.save'))
  }

  it("refuses the app's own Local API Server as an endpoint", async () => {
    render(<EndpointsPage />)

    fillNewEndpoint('http://127.0.0.1:1337/v1')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'endpoints:dialog.ownServer'
    )
    expect(checkProviderEndpoint).not.toHaveBeenCalled()
    expect(addProvider).not.toHaveBeenCalled()
    expect(registerRemoteProvider).not.toHaveBeenCalled()
  })

  it('keeps an endpoint whose server refuses the key out, and says why', async () => {
    checkProviderEndpoint.mockResolvedValueOnce({
      ok: false,
      latencyMs: 12,
      modelCount: 0,
      httpStatus: 401,
      message:
        'Authentication failed: an API key is required or invalid for Lan-vllm.',
    })
    render(<EndpointsPage />)

    fillNewEndpoint('http://192.168.1.30:8000/v1', 'invalid-qa-test-key')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'endpoints:dialog.keyRejected:Lan-vllm Authentication failed: an API key is required or invalid for Lan-vllm.'
    )
    expect(addProvider).not.toHaveBeenCalled()
    expect(saveProviderApiKey).not.toHaveBeenCalled()
    // Still open, so the key can be corrected.
    expect(screen.getByText('endpoints:dialog.addTitle')).toBeInTheDocument()
  })

  it('saves a refused key anyway when asked, as not verified', async () => {
    const refusal = {
      ok: false,
      latencyMs: 12,
      modelCount: 0,
      httpStatus: 401,
      message: 'Authentication failed for Lan-vllm.',
    }
    checkProviderEndpoint
      .mockResolvedValueOnce(refusal)
      .mockResolvedValueOnce(refusal)
    render(<EndpointsPage />)

    fillNewEndpoint('http://192.168.1.30:8000/v1', 'sk-gateway')
    fireEvent.click(await screen.findByText('endpoints:dialog.saveAnyway'))

    await waitFor(() => expect(addProvider).toHaveBeenCalled())
    expect(saveProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-gateway' })
    )
    expect(
      useProviderKeyStatusStore.getState().statuses['lan-vllm']
    ).toMatchObject({
      state: 'unverified',
      message:
        'endpoints:dialog.keyRejected:Lan-vllm Authentication failed for Lan-vllm.',
    })
  })

  it('saves a key the server answers 403, as not verified rather than refused', async () => {
    checkProviderEndpoint.mockResolvedValueOnce({
      ok: false,
      latencyMs: 12,
      modelCount: 0,
      httpStatus: 403,
      message: 'Access forbidden: check your API key permissions for Lan-vllm.',
      responseBody: '{"error":{"message":"models route disabled"}}',
    })
    render(<EndpointsPage />)

    fillNewEndpoint('http://192.168.1.30:8000/v1', 'sk-scoped')

    await waitFor(() => expect(addProvider).toHaveBeenCalled())
    expect(
      useProviderKeyStatusStore.getState().statuses['lan-vllm']
    ).toMatchObject({
      state: 'unverified',
      message: 'HTTP 403: models route disabled',
    })
  })

  it('saves an endpoint it could not reach, its key marked not verified', async () => {
    checkProviderEndpoint.mockResolvedValueOnce({
      ok: false,
      latencyMs: 8000,
      modelCount: 0,
      message: 'Cannot connect to Lan-vllm at http://192.168.1.30:8000/v1.',
    })
    render(<EndpointsPage />)

    fillNewEndpoint('http://192.168.1.30:8000/v1', 'sk-new')

    await waitFor(() => expect(addProvider).toHaveBeenCalled())
    expect(
      useProviderKeyStatusStore.getState().statuses['lan-vllm']
    ).toMatchObject({
      state: 'unverified',
      message: 'Cannot connect to Lan-vllm at http://192.168.1.30:8000/v1.',
    })
  })

  it('reads a saved key the server could not confirm as not verified, not connected', () => {
    useProviderKeyStatusStore
      .getState()
      .setStatus('my-server', 'sk-lan', 'unverified', 'Cannot connect')
    render(<EndpointsPage />)

    const status = within(card('My-server')).getByRole('status')
    expect(status).toHaveTextContent(
      'endpoints:status.unverified · Cannot connect'
    )
    expect(status).not.toHaveTextContent('endpoints:status.connected')
  })

  it('configures an endpoint: the name stays, the address and key change', async () => {
    useEndpointCheckStore
      .getState()
      .setResult('my-server', { ok: true, latencyMs: 5, modelCount: 2 })
    render(<EndpointsPage />)

    fireEvent.click(
      screen.getByLabelText('endpoints:actions.configure:My-server')
    )

    const name = screen.getByPlaceholderText('endpoints:dialog.namePlaceholder')
    expect(name).toHaveValue('My-server')
    expect(name).toHaveAttribute('readonly')
    fireEvent.change(screen.getByLabelText('endpoints:dialog.baseUrl'), {
      target: { value: 'http://192.168.1.21:8000/v1 ' },
    })
    fireEvent.change(screen.getByLabelText('endpoints:dialog.apiKey'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByText('endpoints:dialog.save'))

    await waitFor(() => expect(updateProvider).toHaveBeenCalledTimes(2))
    const [urlName, urlPatch] = updateProvider.mock.calls[0]
    expect(urlName).toBe('my-server')
    expect(urlPatch.base_url).toBe('http://192.168.1.21:8000/v1')
    expect(updateSettings).toHaveBeenCalledWith('my-server', urlPatch.settings)
    // An emptied key disconnects: both the mirror and the settings entry.
    const [keyName, keyPatch] = updateProvider.mock.calls[1]
    expect(keyName).toBe('my-server')
    expect(keyPatch.api_key).toBe('')
    expect(saveProviderApiKey).not.toHaveBeenCalled()
    // The old address's ping no longer applies.
    expect(
      useEndpointCheckStore.getState().results['my-server']
    ).toBeUndefined()
    await waitFor(() => expect(refreshProviderModels).toHaveBeenCalled())
  })

  it('removes only an endpoint the user added, after confirming', () => {
    searchState.current = { provider: 'my-server' }
    render(<EndpointsPage />)

    const removeOllama = within(card('Ollama')).getByLabelText(
      'endpoints:actions.remove:Ollama'
    )
    expect(removeOllama).toBeDisabled()

    fireEvent.click(
      within(card('My-server')).getByLabelText(
        'endpoints:actions.remove:My-server'
      )
    )
    expect(
      screen.getByText('endpoints:remove.title:My-server')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText('endpoints:remove.confirm'))

    expect(deleteProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'my-server' })
    )
    expect(navigate).toHaveBeenCalledWith({
      to: '/endpoints/',
      search: {},
      replace: true,
    })
  })

  it("opens an endpoint's models from the URL and toggles them", () => {
    searchState.current = { provider: 'my-server' }
    render(<EndpointsPage />)

    const toggle = within(card('My-server')).getByLabelText(
      'endpoints:actions.showModels:My-server'
    )
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(card('My-server')).getByText('qwen3')).toBeInTheDocument()
    expect(within(card('Ollama')).queryByText('providers:models')).toBeNull()

    fireEvent.click(toggle)
    expect(navigate).toHaveBeenCalledWith({
      to: '/endpoints/',
      search: {},
      replace: true,
    })
  })

  it('connects a media server by listing its models instead of pinging it', () => {
    render(<EndpointsPage />)

    const media = card('Automatic1111 / Forge')
    expect(within(media).queryByText('endpoints:actions.ping')).toBeNull()
    // Nothing to expand without the core's media catalog.
    expect(
      within(media).queryByLabelText(
        'endpoints:actions.showModels:Automatic1111 / Forge'
      )
    ).toBeNull()

    fireEvent.click(within(media).getByTestId('cloud-media-server-connect'))
    expect(connectMediaServer).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'automatic1111' })
    )
  })
})

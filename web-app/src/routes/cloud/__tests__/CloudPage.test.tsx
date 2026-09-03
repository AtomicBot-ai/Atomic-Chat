import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CloudPage } from '../index'
import { useModelProvider } from '@/hooks/useModelProvider'

const {
  navigate,
  searchState,
  saveProviderApiKey,
  refreshProviderModels,
  auth,
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  searchState: { current: {} as { provider?: string } },
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
  const actual =
    await vi.importActual<typeof import('@/lib/provider-api-key')>(
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
  providers: () => ({ updateSettings: vi.fn().mockResolvedValue(undefined) }),
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
      const state = { status: 'idle', fetchedAt: null, refresh: vi.fn(), error: null }
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
      getProviderByName: () => undefined,
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
  { provider: 'llamacpp-upstream', active: true, models: [], settings: [], persist: true },
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

const mockStore = (list: ProviderObject[] = providers) => {
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
    auth.chatgptStatus.mockResolvedValue({ connected: false })
    auth.chatgptCancelLogin.mockResolvedValue(undefined)
    auth.chatgptModels.mockResolvedValue([])
    mockStore()
  })

  it('renders the subscription card only while its provider is selected', () => {
    searchState.current = { provider: 'openai' }
    const { unmount } = render(<CloudPage />)

    expect(screen.getByText('cloud:connection.title')).toBeInTheDocument()
    expect(
      screen.queryByText('cloud:subscription.title')
    ).not.toBeInTheDocument()
    unmount()

    searchState.current = { provider: 'chatgpt' }
    render(<CloudPage />)

    expect(screen.getByText('cloud:subscription.title')).toBeInTheDocument()
    // The connection card keeps its picker but hands the body to the
    // subscription card — no second, always-"not connected" status line.
    expect(screen.getByText('cloud:connection.title')).toBeInTheDocument()
    expect(
      screen.queryByText('cloud:connection.routing')
    ).not.toBeInTheDocument()
  })

  it('offers browser sign-in and keeps device code disabled', async () => {
    searchState.current = { provider: 'chatgpt' }
    render(<CloudPage />)
    await waitFor(() =>
      expect(auth.chatgptStatus.mock.calls.length).toBeGreaterThan(0)
    )

    expect(
      screen.getByText('cloud:subscription.connectInBrowser').closest('button')
    ).toBeEnabled()
    // Device-code grant is unverified against OpenAI's client; see the ADR.
    expect(
      screen.getByText('cloud:subscription.useDeviceCode').closest('button')
    ).toBeDisabled()
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
    expect(
      screen.getByText('cloud:connection.disconnect')
    ).toBeInTheDocument()
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

  it('shows no models card while nothing is connected', () => {
    // Nothing here has a key, and the keyless Ollama has never answered.
    mockStore()
    render(<CloudPage />)

    expect(screen.getByText('cloud:connection.placeholder')).toBeInTheDocument()
    expect(screen.queryByText('providers:models')).not.toBeInTheDocument()
  })

  it('opens on an already-connected provider when the URL names none', () => {
    // `ollama` needs no key, but only a served model list proves the daemon is
    // actually there — an empty one is not a connection to open on.
    mockStore(
      providers.map((p) =>
        p.provider === 'ollama'
          ? { ...p, models: [{ id: 'llama3' } as Model] }
          : p
      )
    )
    render(<CloudPage />)

    expect(screen.getByText('providers:models')).toBeInTheDocument()
    expect(
      screen.queryByText('cloud:connection.placeholder')
    ).not.toBeInTheDocument()
  })

  it('opens on the provider named in the URL', () => {
    searchState.current = { provider: 'openai' }
    render(<CloudPage />)

    expect(screen.getByText('providers:models')).toBeInTheDocument()
    expect(screen.getByText('cloud:models.count')).toBeInTheDocument()
  })

  it('writes the key to both the settings entry and the mirror', () => {
    searchState.current = { provider: 'openai' }
    render(<CloudPage />)

    fireEvent.change(screen.getByPlaceholderText('sk-…'), {
      target: { value: '  sk-live  ' },
    })
    fireEvent.click(screen.getByText('cloud:connection.connect'))

    const call = vi.mocked(saveProviderApiKey).mock.calls[0][0]
    expect(call.apiKey).toBe('sk-live')
    expect(call.provider.provider).toBe('openai')
  })

  it('trims the base URL before storing it', () => {
    searchState.current = { provider: 'openai' }
    render(<CloudPage />)

    fireEvent.change(
      screen.getByDisplayValue('https://api.openai.com/v1'),
      { target: { value: ' https://proxy.test/v1 ' } }
    )

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
})

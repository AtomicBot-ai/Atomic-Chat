import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceHub } from '@/services'
import { ensureRemoteProviderReady } from './ensureRemoteProviderReady'

const { registerRemoteProvider, setServerStatus, setServerPort } = vi.hoisted(
  () => ({
    registerRemoteProvider: vi.fn(),
    setServerStatus: vi.fn(),
    setServerPort: vi.fn(),
  })
)

vi.mock('@/utils/registerRemoteProvider', () => ({
  isLocalProvider: (provider: string) =>
    ['llamacpp', 'llamacpp-upstream', 'mlx', 'foundation-models'].includes(
      provider
    ),
  isKeylessRemoteProvider: (provider: ModelProvider) =>
    provider.base_url?.startsWith('http://localhost') ?? false,
  isSubscriptionProvider: (provider: string) => provider === 'chatgpt',
  registerRemoteProvider,
}))

vi.mock('@/hooks/useAppState', () => ({
  useAppState: {
    getState: () => ({ setServerStatus }),
  },
}))

vi.mock('@/hooks/useLocalApiServer', () => ({
  useLocalApiServer: {
    getState: () => ({
      serverHost: '127.0.0.1',
      serverPort: 1337,
      apiPrefix: '/v1',
      apiKey: '',
      trustedHosts: [],
      corsEnabled: true,
      verboseLogs: false,
      proxyTimeout: 600,
      setServerPort,
    }),
  },
}))

const provider = {
  provider: 'openai',
  base_url: 'https://api.openai.com/v1',
  api_key: 'test-key',
  models: [{ id: 'gpt-test' }],
} as ModelProvider

function serviceHubWithStatus(running: boolean): Pick<ServiceHub, 'app'> {
  return {
    app: () =>
      ({
        getServerStatus: vi.fn().mockResolvedValue(running),
      }) as ReturnType<ServiceHub['app']>,
  }
}

describe('ensureRemoteProviderReady', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerRemoteProvider.mockResolvedValue(true)
    window.core = {
      api: {
        startServer: vi.fn().mockResolvedValue(1337),
      },
    } as typeof window.core
  })

  it('registers a remote provider without restarting a running proxy', async () => {
    await ensureRemoteProviderReady(provider, serviceHubWithStatus(true))

    expect(registerRemoteProvider).toHaveBeenCalledWith(provider)
    expect(window.core?.api?.startServer).not.toHaveBeenCalled()
    expect(setServerStatus).toHaveBeenCalledWith('running')
  })

  it('starts the proxy before resolving when it is stopped', async () => {
    await ensureRemoteProviderReady(provider, serviceHubWithStatus(false))

    expect(window.core?.api?.startServer).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 1337,
      prefix: '/v1',
      apiKey: '',
      trustedHosts: [],
      isCorsEnabled: true,
      isVerboseEnabled: false,
      proxyTimeout: 600,
    })
    expect(setServerStatus).toHaveBeenNthCalledWith(1, 'pending')
    expect(setServerStatus).toHaveBeenLastCalledWith('running')
  })

  it('rejects a remote provider without a base URL before registration', async () => {
    await expect(
      ensureRemoteProviderReady(
        { ...provider, base_url: '' },
        serviceHubWithStatus(false)
      )
    ).rejects.toThrow('has no configured base URL')

    expect(registerRemoteProvider).not.toHaveBeenCalled()
  })

  // ATO-524: the first message after connecting Codex failed with "Failed to
  // create model: Server is already running" because another path raised the
  // proxy between this check and this start.
  it('survives a start from outside its queue landing first', async () => {
    // The Rust singleton as it answered then: whoever takes the lock first
    // binds; a start waiting behind it finds the server up and is refused —
    // as a bare string, which is how a Tauri command rejects.
    let running = false
    let claimed = false
    let release!: () => void
    const bound = new Promise<void>((resolve) => (release = resolve))
    const startServer = vi.fn(async () => {
      const first = !claimed
      claimed = true
      await bound
      if (!first) throw 'Server is already running'
      running = true
      return 1337
    })
    window.core = { api: { startServer } } as unknown as typeof window.core
    const hub = {
      app: () => ({ getServerStatus: vi.fn(async () => running) }),
    } as unknown as Pick<ServiceHub, 'app'>

    // switchModel's own start, then the send — both see the proxy stopped.
    const external = startServer()
    const send = ensureRemoteProviderReady(provider, hub)
    await vi.waitFor(() => expect(startServer).toHaveBeenCalledTimes(2))
    release()

    await expect(external).resolves.toBe(1337)
    await expect(send).resolves.toBeUndefined()
    expect(setServerStatus).toHaveBeenLastCalledWith('running')
    expect(setServerStatus).not.toHaveBeenCalledWith('stopped')
  })

  it('still fails, and reports the proxy stopped, when the start really fails', async () => {
    window.core = {
      api: { startServer: vi.fn().mockRejectedValue('Invalid address: nope') },
    } as unknown as typeof window.core

    await expect(
      ensureRemoteProviderReady(provider, serviceHubWithStatus(false))
    ).rejects.toBe('Invalid address: nope')

    expect(setServerStatus).toHaveBeenLastCalledWith('stopped')
  })
})

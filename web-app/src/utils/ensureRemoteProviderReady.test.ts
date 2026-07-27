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
})

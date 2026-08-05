import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DataProvider } from '../DataProvider'
import type { ServiceHub } from '@/services'
import { seedServiceHub } from '@/test/service-hub'

const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  initializeWithLastUsed: vi.fn(),
  navigate: vi.fn(),
  setAssistants: vi.fn(),
  setMessages: vi.fn(),
  setProviders: vi.fn(),
  setServerStatus: vi.fn(),
  setServers: vi.fn(),
  setSettings: vi.fn(),
  setThreads: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: () => ({ setThreads: mocks.setThreads }),
}))

vi.mock('@/hooks/useModelProvider', () => {
  const state = {
    providers: [],
    selectedModel: null,
    selectedProvider: 'llamacpp-upstream',
    getProviderByName: vi.fn(),
    setProviders: mocks.setProviders,
    updateProvider: vi.fn(),
  }
  const useModelProvider = () => ({ setProviders: mocks.setProviders })
  useModelProvider.getState = () => state
  return { useModelProvider }
})

vi.mock('@/hooks/useAssistant', () => ({
  defaultAssistant: {
    id: 'jan',
    name: 'Atomic Chat',
    description: 'Built-in description',
    avatar: '/images/transparent-logo.png',
    instructions: 'Current date: {{current_date}}',
  },
  useAssistant: () => ({
    setAssistants: mocks.setAssistants,
    initializeWithLastUsed: mocks.initializeWithLastUsed,
  }),
}))

vi.mock('@/hooks/useMessages', () => ({
  useMessages: () => ({ setMessages: mocks.setMessages }),
}))

vi.mock('@/hooks/useAppUpdater', () => ({
  useAppUpdater: () => ({ checkForUpdate: mocks.checkForUpdate }),
}))

vi.mock('@/hooks/useMCPServers', () => ({
  DEFAULT_MCP_SETTINGS: {
    enabled: true,
  },
  useMCPServers: () => ({
    setServers: mocks.setServers,
    setSettings: mocks.setSettings,
  }),
}))

vi.mock('@/hooks/useAppState', () => {
  const state = {
    activeModels: [],
    serverStatus: 'stopped',
    setActiveModels: vi.fn(),
    setServerStatus: mocks.setServerStatus,
  }
  const useAppState = (selector: (value: typeof state) => unknown) =>
    selector(state)
  useAppState.getState = () => state
  return { useAppState }
})

vi.mock('@/hooks/useLocalApiServer', () => ({
  useLocalApiServer: {
    getState: () => ({
      enableOnStartup: true,
      serverHost: '127.0.0.1',
      serverPort: 1337,
      apiPrefix: '/v1',
      apiKey: '',
      trustedHosts: [],
      corsEnabled: false,
      verboseLogs: false,
      proxyTimeout: 120,
      setServerPort: vi.fn(),
    }),
  },
}))

vi.mock('@/hooks/useModelLoad', () => ({
  useModelLoad: {
    getState: () => ({ onboardingActive: false }),
  },
}))

vi.mock('@/utils/registerRemoteProvider', () => ({
  isKeylessRemoteProvider: () => false,
  isLocalProvider: (provider: string) =>
    ['llamacpp', 'llamacpp-upstream', 'mlx', 'foundation-models'].includes(
      provider
    ),
  registerRemoteProvider: vi.fn(),
  unregisterRemoteProvider: vi.fn(),
}))

vi.mock('@/utils/activeModelsSync', () => ({
  hydrateActiveModelsForRunningServer: vi.fn(),
}))

vi.mock('@janhq/core', () => ({
  AppEvent: { onModelImported: 'onModelImported' },
  ModelEvent: { OnAutoIncreasedCtxLen: 'OnAutoIncreasedCtxLen' },
  events: {
    on: vi.fn(),
    off: vi.fn(),
  },
}))

describe('DataProvider', () => {
  const providers = [
    {
      provider: 'openai',
      active: false,
      models: [],
      settings: [],
    },
  ] as ModelProvider[]
  const mcpConfig = {
    mcpServers: { filesystem: { command: 'server' } },
    mcpSettings: { enabled: false },
  }
  const assistants = [
    {
      id: 'assistant-1',
      name: 'Test assistant',
      description: '',
      avatar: '',
    },
  ] as Assistant[]
  const threads = [{ id: 'thread-1', title: 'Test thread' }] as Thread[]

  const getProviders = vi.fn()
  const getMCPConfig = vi.fn()
  const getAssistants = vi.fn()
  const getCurrent = vi.fn()
  const onOpenUrl = vi.fn()
  const listen = vi.fn()
  const fetchThreads = vi.fn()
  const getServerStatus = vi.fn()
  const getActiveModels = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    getProviders.mockResolvedValue(providers)
    getMCPConfig.mockResolvedValue(mcpConfig)
    getAssistants.mockResolvedValue(assistants)
    getCurrent.mockResolvedValue([])
    onOpenUrl.mockReturnValue(undefined)
    listen.mockResolvedValue(vi.fn())
    fetchThreads.mockResolvedValue(threads)
    getServerStatus.mockResolvedValue(false)
    getActiveModels.mockResolvedValue([])

    seedServiceHub({
      providers: {
        getProviders,
      } as unknown as ReturnType<ServiceHub['providers']>,
      mcp: {
        getMCPConfig,
      } as unknown as ReturnType<ServiceHub['mcp']>,
      assistants: {
        getAssistants,
      } as unknown as ReturnType<ServiceHub['assistants']>,
      deeplink: {
        getCurrent,
        onOpenUrl,
      } as unknown as ReturnType<ServiceHub['deeplink']>,
      events: {
        listen,
      } as unknown as ReturnType<ServiceHub['events']>,
      threads: {
        fetchThreads,
      } as unknown as ReturnType<ServiceHub['threads']>,
      app: {
        getServerStatus,
      } as unknown as ReturnType<ServiceHub['app']>,
      models: {
        getActiveModels,
      } as unknown as ReturnType<ServiceHub['models']>,
    })
  })

  it('hydrates startup stores from service data while rendering no UI', async () => {
    const { container, unmount } = render(<DataProvider />)

    expect(container).toBeEmptyDOMElement()
    await waitFor(() => {
      expect(mocks.setProviders).toHaveBeenCalledWith(providers)
      expect(mocks.setServers).toHaveBeenCalledWith(mcpConfig.mcpServers)
      expect(mocks.setSettings).toHaveBeenCalledWith(mcpConfig.mcpSettings)
      expect(mocks.setAssistants).toHaveBeenCalledWith(assistants)
      expect(mocks.initializeWithLastUsed).toHaveBeenCalledOnce()
      expect(mocks.setThreads).toHaveBeenCalledWith(threads)
      expect(getServerStatus).toHaveBeenCalledOnce()
      expect(getActiveModels).toHaveBeenCalledOnce()
    })
    unmount()
  })

  it('preserves saved settings when migrating the built-in assistant', async () => {
    const savedAssistant = {
      id: 'jan',
      name: 'Old name',
      description: 'Old description',
      avatar: 'old-avatar.png',
      instructions: 'User instructions',
      created_at: 123,
      parameters: { temperature: 0.2 },
    } as Assistant
    getAssistants.mockResolvedValue([savedAssistant])
    let migratedAssistants: Assistant[] | undefined
    mocks.setAssistants.mockImplementation((value: Assistant[]) => {
      migratedAssistants = value
    })

    const { unmount } = render(<DataProvider />)

    await waitFor(() => {
      expect(migratedAssistants).toEqual([
        {
          ...savedAssistant,
          name: 'Atomic Chat',
          description: 'Built-in description',
          avatar: '/images/transparent-logo.png',
        },
      ])
    })
    unmount()
  })

  it('routes a startup deep link through the production parser', async () => {
    const navigations: unknown[] = []
    mocks.navigate.mockImplementation((destination) => {
      navigations.push(destination)
    })
    getCurrent.mockResolvedValue([
      'atomic-chat://models/huggingface/owner/model-GGUF',
    ])
    const { unmount } = render(<DataProvider />)

    await waitFor(() => {
      expect(navigations).toEqual([
        {
          to: '/hub/$modelId',
          params: { modelId: 'owner/model-GGUF' },
          search: { repo: 'owner/model-GGUF' },
        },
      ])
    })
    unmount()
  })
})

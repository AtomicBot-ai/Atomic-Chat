import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DataProvider,
  applyAtomicCoreServerState,
  handleCoreSessionDied,
} from '../DataProvider'
import { ModelFactory } from '@/lib/model-factory'
import type { ServiceHub } from '@/services'
import { seedServiceHub } from '@/test/service-hub'

const mocks = vi.hoisted(() => ({
  switchToModel: vi.fn(),
  // WS2 backoff gate. Default-allow so the existing cases keep exercising the
  // auto-switch itself; the suppression case sets it false explicitly.
  shouldAttemptAutoStart: vi.fn(() => true),
  chatBusy: false,
  checkForUpdate: vi.fn(),
  initializeWithLastUsed: vi.fn(),
  navigate: vi.fn(),
  setAssistants: vi.fn(),
  setMessages: vi.fn(),
  setProviders: vi.fn(),
  clearDeletedModel: vi.fn(),
  setServerStatus: vi.fn(),
  setServerPort: vi.fn(),
  setActiveModels: vi.fn(),
  toastError: vi.fn(),
  setServers: vi.fn(),
  setSettings: vi.fn(),
  setThreads: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError },
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
    clearDeletedModel: mocks.clearDeletedModel,
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
    activeModels: [] as string[],
    serverStatus: 'stopped',
    setActiveModels: mocks.setActiveModels,
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
      setServerPort: mocks.setServerPort,
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
  isSubscriptionProvider: (provider: string) => provider === 'chatgpt',
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

vi.mock('@/utils/switchModel', () => ({
  switchToModel: mocks.switchToModel,
  shouldAttemptAutoStart: mocks.shouldAttemptAutoStart,
}))

vi.mock('@/stores/chat-session-store', () => ({
  isAnyChatBusy: () => mocks.chatBusy,
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
    // `DeepLinkService.onOpenUrl` resolves to a detacher; the provider now
    // keeps that detacher so the handler is released on unmount.
    onOpenUrl.mockResolvedValue(vi.fn())
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

  it('uses the confirmed fallback port and listener state from the core', async () => {
    applyAtomicCoreServerState({ running: true, port: 6768 })
    expect(mocks.setServerPort).toHaveBeenCalledWith(6768)
    expect(mocks.setServerStatus).toHaveBeenCalledWith('running')
    applyAtomicCoreServerState({ running: false, port: null })
    expect(mocks.setServerStatus).toHaveBeenCalledWith('stopped')
  })

  it('reconciles the real port when opening a window onto an existing listener', async () => {
    getServerStatus.mockResolvedValue(true)
    const startServer = vi.fn().mockResolvedValue(6768)
    const previous = window.core?.api?.startServer
    if (window.core?.api) window.core.api.startServer = startServer
    const { unmount } = render(<DataProvider />)
    await waitFor(() => expect(mocks.setServerPort).toHaveBeenCalledWith(6768))
    if (window.core?.api) window.core.api.startServer = previous
    unmount()
  })

  describe('atomic-core session:died', () => {
    const toastOptions = () =>
      mocks.toastError.mock.calls[0]?.[1] as
        | { id?: string; description?: string }
        | undefined

    it('drops a crashed llama.cpp model from the active set and explains the Vulkan case', async () => {
      const { useAppState } = await import('@/hooks/useAppState')
      useAppState.getState().activeModels = ['crashed', 'other']
      const invalidate = vi.spyOn(ModelFactory, 'invalidateLocalSessionCache')

      handleCoreSessionDied(
        {
          provider: 'llamacpp-upstream',
          pid: 42,
          model_id: 'crashed',
          exit_code: null,
          signal: 'SIGSEGV',
          message: 'llama-server exited',
        },
        { generating: true, macos: false }
      )

      expect(invalidate.mock.calls).toEqual([['llamacpp-upstream', 'crashed']])
      expect(mocks.setActiveModels.mock.calls).toEqual([[['other']]])
      expect(mocks.toastError.mock.calls[0]?.[0]).toBe(
        'Model crashed during generation'
      )
      expect(toastOptions()?.id).toBe('session-died-crashed')
      expect(toastOptions()?.description).toContain('Vulkan')
      useAppState.getState().activeModels = []
    })

    it('does not blame a generation that was not running, nor Vulkan on macOS', () => {
      handleCoreSessionDied(
        { provider: 'llamacpp-upstream', pid: 42, model_id: 'idle' },
        { generating: false, macos: true }
      )

      expect(mocks.toastError.mock.calls[0]?.[0]).toBe(
        'Model stopped unexpectedly'
      )
      expect(toastOptions()?.description).not.toContain('Vulkan')
      expect(toastOptions()?.description).not.toContain('CPU backend')
    })

    it('applies the same recovery to MLX without the llama.cpp backend advice', async () => {
      const { useAppState } = await import('@/hooks/useAppState')
      useAppState.getState().activeModels = ['mlx-model']
      const invalidate = vi.spyOn(ModelFactory, 'invalidateLocalSessionCache')

      handleCoreSessionDied({ provider: 'mlx', pid: 7, model_id: 'mlx-model' })

      expect(invalidate.mock.calls).toEqual([['mlx', 'mlx-model']])
      expect(mocks.setActiveModels.mock.calls).toEqual([[[]]])
      expect(toastOptions()?.description).not.toContain('Vulkan')
      useAppState.getState().activeModels = []
    })

    it('does not touch the session cache for Foundation Models, which it does not cache', () => {
      const invalidate = vi.spyOn(ModelFactory, 'invalidateLocalSessionCache')

      handleCoreSessionDied({
        provider: 'foundation-models',
        pid: 9,
        model_id: 'apple/on-device',
      })

      expect(invalidate.mock.calls).toEqual([])
      expect(mocks.setActiveModels.mock.calls).toEqual([])
      expect(toastOptions()?.id).toBe('session-died-apple/on-device')
    })
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

  it('auto-switches an imported model to an active provider, skipping a deactivated one', async () => {
    // Both llama.cpp providers list every GGUF from the shared models dir.
    // TurboQuant comes first in the array but is deactivated (the fresh-install
    // default) — the auto-switch must land on upstream.
    const { useModelProvider } = await import('@/hooks/useModelProvider')
    const { events } = await import('@janhq/core')
    const state = useModelProvider.getState() as unknown as {
      providers: unknown[]
    }
    state.providers = [
      {
        provider: 'llamacpp',
        active: false,
        models: [{ id: 'imported-model' }],
        settings: [],
      },
      {
        provider: 'llamacpp-upstream',
        active: true,
        models: [{ id: 'imported-model' }],
        settings: [],
      },
    ]
    mocks.switchToModel.mockResolvedValue(undefined)

    const { unmount } = render(<DataProvider />)
    await waitFor(() => {
      expect(events.on).toHaveBeenCalledWith(
        'onModelImported',
        expect.any(Function)
      )
    })

    const handler = vi
      .mocked(events.on)
      .mock.calls.find(([event]) => event === 'onModelImported')?.[1] as (
      data?: Record<string, unknown>
    ) => Promise<void>
    await handler({ modelId: 'imported-model' })

    expect(mocks.switchToModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'imported-model',
        providerName: 'llamacpp-upstream',
        isAutoStart: true,
      })
    )

    state.providers = []
    unmount()
  })

  it('respects the auto-start backoff after a model has already failed', async () => {
    // This path calls switchToModel with `isAutoStart: true` but never asked
    // the gate, so a model that cannot load could be retried from here on
    // every import event — one of the ways a single device produced 62.9% of
    // every model_load in the project.
    const { useModelProvider } = await import('@/hooks/useModelProvider')
    const { events } = await import('@janhq/core')
    const state = useModelProvider.getState() as unknown as {
      providers: unknown[]
    }
    state.providers = [
      {
        provider: 'llamacpp-upstream',
        active: true,
        models: [{ id: 'broken-model' }],
        settings: [],
      },
    ]
    mocks.shouldAttemptAutoStart.mockReturnValue(false)

    const { unmount } = render(<DataProvider />)
    await waitFor(() => {
      expect(events.on).toHaveBeenCalledWith(
        'onModelImported',
        expect.any(Function)
      )
    })

    const handler = vi
      .mocked(events.on)
      .mock.calls.find(([event]) => event === 'onModelImported')?.[1] as (
      data?: Record<string, unknown>
    ) => Promise<void>
    await handler({ modelId: 'broken-model' })

    expect(mocks.switchToModel).not.toHaveBeenCalled()

    mocks.shouldAttemptAutoStart.mockReturnValue(true)
    state.providers = []
    unmount()
  })

  describe('imported-model auto-switch provider resolution', () => {
    const bothActive = [
      {
        provider: 'llamacpp',
        active: true,
        models: [{ id: 'imported-model' }],
        settings: [],
      },
      {
        provider: 'llamacpp-upstream',
        active: true,
        models: [{ id: 'imported-model' }],
        settings: [],
      },
    ]

    async function fireImport(
      providersList: unknown[],
      payload: Record<string, unknown>
    ) {
      const { useModelProvider } = await import('@/hooks/useModelProvider')
      const { events } = await import('@janhq/core')
      const state = useModelProvider.getState() as unknown as {
        providers: unknown[]
      }
      state.providers = providersList
      mocks.switchToModel.mockResolvedValue(undefined)
      const { unmount } = render(<DataProvider />)
      await waitFor(() => {
        expect(events.on).toHaveBeenCalledWith(
          'onModelImported',
          expect.any(Function)
        )
      })
      const handler = vi
        .mocked(events.on)
        .mock.calls.find(([event]) => event === 'onModelImported')?.[1] as (
        data?: Record<string, unknown>
      ) => Promise<void>
      await handler(payload)
      state.providers = []
      unmount()
    }

    beforeEach(() => {
      mocks.chatBusy = false
    })

    it('prefers the selected provider when both llama.cpp providers list the model', async () => {
      // TurboQuant is first in the array AND active (existing profiles keep
      // it on), but the user is chatting with upstream. Loading into
      // TurboQuant would put a second copy of the model in memory.
      await fireImport(bothActive, { modelId: 'imported-model' })

      expect(mocks.switchToModel).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: 'imported-model',
          providerName: 'llamacpp-upstream',
          isAutoStart: true,
        })
      )
    })

    it('skips the auto-switch while a chat is streaming', async () => {
      mocks.chatBusy = true
      await fireImport(bothActive, { modelId: 'imported-model' })

      expect(mocks.switchToModel).not.toHaveBeenCalled()
    })

    it('skips the auto-switch when the resolved engine already serves the model', async () => {
      getActiveModels.mockImplementation(async (provider?: string) =>
        provider === 'llamacpp-upstream' ? ['imported-model'] : []
      )
      await fireImport(bothActive, { modelId: 'imported-model' })

      expect(getActiveModels).toHaveBeenCalledWith('llamacpp-upstream')
      expect(mocks.switchToModel).not.toHaveBeenCalled()
    })
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

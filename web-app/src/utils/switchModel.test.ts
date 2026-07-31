import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceHub } from '@/services'
import { switchToModel } from './switchModel'

const { appState, localApiState, modelProviderState, startServer, stopServer } =
  vi.hoisted(() => ({
    appState: {
      serverStatus: 'running' as 'running' | 'stopped' | 'pending',
      activeModels: [] as string[],
      setServerStatus: vi.fn(),
      setActiveModels: vi.fn(),
      updateLoadingModel: vi.fn(),
    },
    localApiState: {
      enableOnStartup: false,
      serverHost: '127.0.0.1',
      serverPort: 1337,
      apiPrefix: '/v1',
      apiKey: '',
      trustedHosts: [] as string[],
      corsEnabled: true,
      verboseLogs: false,
      proxyTimeout: 600,
      setServerPort: vi.fn(),
      setDefaultModelLocalApiServer: vi.fn(),
      setLastServerModels: vi.fn(),
    },
    modelProviderState: {
      providers: [
        {
          provider: 'mlx',
          models: [{ id: 'broken-model' }],
        },
      ],
      selectModelProvider: vi.fn(),
    },
    startServer: vi.fn(),
    stopServer: vi.fn(),
  }))

vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/hooks/useAppState', () => ({
  useAppState: {
    getState: () => appState,
  },
}))

vi.mock('@/hooks/useLocalApiServer', () => ({
  useLocalApiServer: {
    getState: () => localApiState,
  },
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => modelProviderState,
  },
}))

vi.mock('@/hooks/useModelLoad', () => ({
  useModelLoad: {
    getState: () => ({ setModelLoadError: vi.fn() }),
  },
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: {
    getState: () => ({ updateCurrentThreadModel: vi.fn() }),
  },
}))

vi.mock('@/utils/registerRemoteProvider', () => ({
  isKeylessRemoteProvider: vi.fn(() => false),
  registerRemoteProvider: vi.fn(),
}))

vi.mock('@/utils/activeModelsSync', () => ({
  syncActiveModelsFromEngines: vi.fn(),
}))

vi.mock('@/lib/telemetry', () => ({
  isRecoverableModelLoadCode: vi.fn(() => true),
  loadBackendFromProvider: vi.fn(() => 'mlx'),
  mmprojProjectorType: vi.fn(() => null),
  modelLoadSource: vi.fn(() => 'local'),
  oomSubtype: vi.fn(() => null),
  quantFromModelId: vi.fn(() => null),
  sanitizeStderrTail: vi.fn(() => ''),
  shouldCaptureModelLoadSentry: vi.fn(() => false),
  shouldEmitModelLoadFailure: vi.fn(() => false),
}))

vi.mock('@/lib/sentry', () => ({
  captureHandledError: vi.fn(),
}))

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn() },
}))

vi.mock('@/i18n/setup', () => ({
  default: { t: (key: string) => key },
}))

describe('switchToModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appState.serverStatus = 'running'
    startServer.mockResolvedValue(1337)
    stopServer.mockResolvedValue(undefined)
    window.core = {
      api: {
        startServer,
        stopServer,
      },
    } as typeof window.core
  })

  it('restores a previously running API server after model load failure', async () => {
    const models = {
      getActiveModels: vi.fn().mockResolvedValue([]),
      stopAllModels: vi.fn().mockResolvedValue(undefined),
      startModel: vi
        .fn()
        .mockRejectedValue(new Error('missing vision weights')),
    }
    const serviceHub = {
      app: () => ({
        getServerStatus: vi.fn().mockResolvedValue(false),
      }),
      models: () => models,
    } as unknown as ServiceHub

    await expect(
      switchToModel({
        modelId: 'broken-model',
        providerName: 'mlx',
        serviceHub,
      })
    ).rejects.toThrow('missing vision weights')

    expect(stopServer).toHaveBeenCalledOnce()
    expect(startServer).toHaveBeenCalledOnce()
    expect(appState.setServerStatus).toHaveBeenLastCalledWith('running')
  })
})

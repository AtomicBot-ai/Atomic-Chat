import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceHub } from '@/services'
import {
  isExplicitSwitchPending,
  shouldAttemptAutoStart,
  splitModelLoadError,
  switchToModel,
} from './switchModel'

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

  it('blocks the auto-start path while an explicit switch for the same target is in flight', async () => {
    let releaseStart = () => {}
    const startModel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve
        })
    )
    const models = {
      getActiveModels: vi.fn().mockResolvedValue(['ready-model']),
      stopAllModels: vi.fn().mockResolvedValue(undefined),
      startModel,
    }
    const serviceHub = {
      app: () => ({
        getServerStatus: vi.fn().mockResolvedValue(false),
      }),
      models: () => models,
    } as unknown as ServiceHub

    const pending = switchToModel({
      modelId: 'ready-model',
      providerName: 'mlx',
      serviceHub,
    })
    await vi.waitFor(() => expect(startModel).toHaveBeenCalled())

    // ChatInput's effect fires on the same selection change that started this
    // switch; it must not probe the engines and queue a duplicate switch.
    expect(isExplicitSwitchPending('mlx', 'ready-model')).toBe(true)
    expect(shouldAttemptAutoStart('mlx', 'ready-model')).toBe(false)
    // A different target is untouched by the marker.
    expect(shouldAttemptAutoStart('mlx', 'other-model')).toBe(true)

    releaseStart()
    await pending

    expect(isExplicitSwitchPending('mlx', 'ready-model')).toBe(false)
    expect(shouldAttemptAutoStart('mlx', 'ready-model')).toBe(true)
  })

  it('stops waiting once the engine reports the freshly started model', async () => {
    const models = {
      getActiveModels: vi.fn().mockResolvedValue(['ready-model']),
      stopAllModels: vi.fn().mockResolvedValue(undefined),
      startModel: vi.fn().mockResolvedValue(undefined),
    }
    const serviceHub = {
      app: () => ({
        getServerStatus: vi.fn().mockResolvedValue(false),
      }),
      models: () => models,
    } as unknown as ServiceHub

    const startedAt = Date.now()
    await switchToModel({
      modelId: 'ready-model',
      providerName: 'mlx',
      serviceHub,
    })

    // Previously every local switch paid a flat 500ms sleep here.
    expect(Date.now() - startedAt).toBeLessThan(400)
    expect(appState.setServerStatus).toHaveBeenLastCalledWith('running')
  })

  it('still waits out the settle budget when the engine has not come up', async () => {
    const models = {
      getActiveModels: vi.fn().mockResolvedValue([]),
      stopAllModels: vi.fn().mockResolvedValue(undefined),
      startModel: vi.fn().mockResolvedValue(undefined),
    }
    const serviceHub = {
      app: () => ({
        getServerStatus: vi.fn().mockResolvedValue(false),
      }),
      models: () => models,
    } as unknown as ServiceHub

    const startedAt = Date.now()
    await switchToModel({
      modelId: 'slow-model',
      providerName: 'mlx',
      serviceHub,
    })

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450)
  })
})

describe('splitModelLoadError', () => {
  it('separates the engine reason from the log it dumped after it', () => {
    const { summary, details } = splitModelLoadError({
      code: 'LLAMA_CPP_PROCESS_ERROR',
      message:
        'The model process crashed unexpectedly (access violation / segfault).\n' +
        'GGML_ASSERT(n_outputs_max <= cparams.n_outputs_max) failed\n' +
        'libggml-base.0.dylib 0x0000000105c13f0 [LLAMA_CPP_PROCESS_ERROR]',
    })

    expect(summary).toBe(
      'The model process crashed unexpectedly (access violation / segfault).'
    )
    expect(details).toContain('GGML_ASSERT')
    expect(details).not.toContain('[LLAMA_CPP_PROCESS_ERROR]')
  })

  it('prefers the structured details field over the flattened message', () => {
    const { summary, details } = splitModelLoadError({
      message: 'Model architecture is not supported.\nignored copy',
      details: 'load_hparams: unknown model architecture',
    })

    expect(summary).toBe('Model architecture is not supported.')
    expect(details).toBe('load_hparams: unknown model architecture')
  })

  it('demotes a one-line wall of text to the details pane', () => {
    const wall = `Something broke ${'and kept going '.repeat(40)}`

    const { summary, details } = splitModelLoadError({ message: wall })

    expect(summary.length).toBeLessThanOrEqual(201)
    expect(summary.endsWith('…')).toBe(true)
    expect(details).toBe(wall.trim())
  })

  it('leaves a short reason without a details pane', () => {
    expect(splitModelLoadError({ message: 'Model file not found.' })).toEqual({
      summary: 'Model file not found.',
      details: undefined,
    })
  })
})

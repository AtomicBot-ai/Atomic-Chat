import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { ServiceHub } from '@/services'
import { captureHandledError } from '@/lib/sentry'
import {
  isRecoverableModelLoadCode,
  shouldCaptureModelLoadSentry,
} from '@/lib/telemetry'
import { registerRemoteProvider } from '@/utils/registerRemoteProvider'
import {
  cancelModelLoad,
  describeModelLoadFailure,
  isExplicitSwitchPending,
  planOomRetry,
  selectThreadModelIfNone,
  shouldAttemptAutoStart,
  splitModelLoadError,
  stopAllLocalModelsByUser,
  switchToModel,
  unloadModelByUser,
} from './switchModel'

const { appState, localApiState, modelProviderState, startServer, stopServer } =
  vi.hoisted(() => ({
    appState: {
      serverStatus: 'running' as 'running' | 'stopped' | 'pending',
      activeModels: [] as string[],
      userStoppedModels: [] as string[],
      setServerStatus: vi.fn(),
      setActiveModels: vi.fn(),
      // Mirrors the store: the stop record is what the auto-start gate reads.
      setUserStoppedModels: vi.fn((keys: string[]) => {
        appState.userStoppedModels = keys
      }),
      updateLoadingModel: vi.fn(),
      setLoadingModelProgress: vi.fn(),
      setLoadingModelCancelling: vi.fn(),
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
        {
          provider: 'llamacpp-upstream',
          models: [{ id: 'shared-model' }],
          settings: [] as unknown[],
        },
      ] as Array<Record<string, unknown>>,
      selectedProvider: '',
      selectedModel: null as { id: string } | null,
      selectModelProvider: vi.fn(),
      // Mirrors the store: a partial update replaces the listed fields.
      updateProvider: (name: string, data: Record<string, unknown>) => {
        const list = modelProviderState.providers as Array<
          Record<string, unknown>
        >
        const index = list.findIndex((p) => p.provider === name)
        if (index !== -1) list[index] = { ...list[index], ...data }
      },
    },
    startServer: vi.fn(),
    stopServer: vi.fn(),
  }))

vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@/hooks/useAppState', () => ({
  modelStopKey: (providerName: string, modelId: string) =>
    `${providerName}::${modelId}`,
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
  isSubscriptionProvider: vi.fn((name: string) => name === 'chatgpt'),
  registerRemoteProvider: vi.fn(),
}))

vi.mock('@/utils/activeModelsSync', () => ({
  syncActiveModelsFromEngines: vi.fn(),
}))

// Partial mock: only the pieces this suite needs to pin down. Listing every
// export instead meant each new telemetry property broke these tests with a
// missing-export error rather than a real failure.
vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry')>()),
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
  // `has_opted_in_capturing` is what `queuedCapture` checks before sending;
  // without it every event would sit in the startup queue instead.
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
}))

vi.mock('@/i18n/setup', () => ({
  default: { t: (key: string) => key },
}))

// In-memory stand-in for the local engines: which model ids each provider has
// loaded. The stop/start methods mirror `DefaultModelsService` so a test can
// assert which copies were unloaded and what is still loaded after a switch,
// not just which method ran.
const createLoadedEngines = (initial: Record<string, string[]>) => {
  const engines = new Map(
    Object.entries(initial).map(([provider, ids]) => [provider, [...ids]])
  )
  const unloaded: string[] = []
  const keep = (provider: string, predicate: (id: string) => boolean) => {
    const ids = engines.get(provider) ?? []
    for (const id of ids) {
      if (!predicate(id)) unloaded.push(`${provider}::${id}`)
    }
    engines.set(provider, ids.filter(predicate))
  }
  return {
    unloaded,
    getActiveModels: async (provider?: string) =>
      provider === undefined
        ? [...engines.values()].flat()
        : [...(engines.get(provider) ?? [])],
    stopAllModels: async () => {
      for (const provider of engines.keys()) keep(provider, () => false)
    },
    stopAllModelsExcept: async (modelId: string, providerName: string) => {
      for (const provider of engines.keys()) {
        keep(provider, (id) => provider === providerName && id === modelId)
      }
    },
    startModel: async (provider: { provider: string }, modelId: string) => {
      const ids = engines.get(provider.provider) ?? []
      if (!ids.includes(modelId)) engines.set(provider.provider, [...ids, modelId])
    },
    snapshot: () => Object.fromEntries(engines),
  }
}

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
      stopAllModelsExcept: vi.fn().mockResolvedValue(undefined),
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
        isAutoStart: true,
      })
    ).rejects.toThrow('missing vision weights')

    expect(stopServer).toHaveBeenCalledOnce()
    expect(startServer).toHaveBeenCalledOnce()
    expect(appState.setServerStatus).toHaveBeenLastCalledWith('running')
    expect(toast.error).toHaveBeenCalledWith(
      'model-errors:modelLoadFailedTitle',
      expect.any(Object)
    )
  })

  it('leaves a local engine failure to the core and reports a cloud one', async () => {
    vi.mocked(isRecoverableModelLoadCode).mockReturnValue(false)
    vi.mocked(shouldCaptureModelLoadSentry).mockReturnValue(true)
    const failingHub = () =>
      ({
        app: () => ({ getServerStatus: vi.fn().mockResolvedValue(false) }),
        models: () => ({
          getActiveModels: vi.fn().mockResolvedValue([]),
          stopAllModels: vi.fn().mockResolvedValue(undefined),
          stopAllModelsExcept: vi.fn().mockResolvedValue(undefined),
          startModel: vi.fn().mockRejectedValue(new Error('engine crashed')),
        }),
      }) as unknown as ServiceHub

    await expect(
      switchToModel({
        modelId: 'local-model',
        providerName: 'mlx',
        serviceHub: failingHub(),
      })
    ).rejects.toThrow('engine crashed')
    expect(captureHandledError).not.toHaveBeenCalled()

    modelProviderState.providers.push({
      provider: 'openai',
      api_key: 'sk-test',
      models: [{ id: 'cloud-model' }],
    })
    vi.mocked(registerRemoteProvider).mockRejectedValueOnce(
      new Error('provider refused')
    )
    try {
      await expect(
        switchToModel({
          modelId: 'cloud-model',
          providerName: 'openai',
          serviceHub: failingHub(),
        })
      ).rejects.toThrow('provider refused')
    } finally {
      modelProviderState.providers.pop()
    }
    expect(captureHandledError).toHaveBeenCalledOnce()
    expect(vi.mocked(captureHandledError).mock.calls[0]?.[2]).toMatchObject({
      feature: 'model_load',
      backend: 'openai',
    })
    vi.mocked(isRecoverableModelLoadCode).mockReturnValue(true)
    vi.mocked(shouldCaptureModelLoadSentry).mockReturnValue(false)
  })

  it('keeps the target engine running and only unloads copies in other providers', async () => {
    // The same GGUF is loaded in both llama.cpp engines (post-download
    // auto-start landed in TurboQuant while the chat loaded upstream). A
    // switch to upstream must drop the TurboQuant copy only — never the
    // upstream server, which may be streaming an answer right now.
    const loaded = createLoadedEngines({
      'llamacpp': ['shared-model'],
      'llamacpp-upstream': ['shared-model'],
    })
    const models = {
      getActiveModels: vi.fn(loaded.getActiveModels),
      stopAllModels: vi.fn(loaded.stopAllModels),
      stopAllModelsExcept: vi.fn(loaded.stopAllModelsExcept),
      startModel: vi.fn(loaded.startModel),
    }
    const serviceHub = {
      app: () => ({
        getServerStatus: vi.fn().mockResolvedValue(true),
      }),
      models: () => models,
    } as unknown as ServiceHub

    await switchToModel({
      modelId: 'shared-model',
      providerName: 'llamacpp-upstream',
      serviceHub,
    })

    expect(models.stopAllModelsExcept).toHaveBeenCalledWith(
      'shared-model',
      'llamacpp-upstream'
    )
    expect(models.stopAllModels).not.toHaveBeenCalled()
    expect(appState.setActiveModels).toHaveBeenCalledWith(['shared-model'])
    // Only the TurboQuant copy was unloaded; the upstream copy never went down.
    expect(loaded.unloaded).toEqual(['llamacpp::shared-model'])
    expect(loaded.snapshot()).toEqual({
      'llamacpp': [],
      'llamacpp-upstream': ['shared-model'],
    })
  })

  it('still stops every local engine when switching to a cloud model', async () => {
    const loaded = createLoadedEngines({
      'llamacpp-upstream': ['shared-model'],
      'mlx': ['broken-model'],
    })
    const models = {
      getActiveModels: vi.fn(loaded.getActiveModels),
      stopAllModels: vi.fn(loaded.stopAllModels),
      stopAllModelsExcept: vi.fn(loaded.stopAllModelsExcept),
      startModel: vi.fn(loaded.startModel),
    }
    const serviceHub = {
      app: () => ({
        getServerStatus: vi.fn().mockResolvedValue(false),
      }),
      models: () => models,
    } as unknown as ServiceHub

    await switchToModel({
      modelId: 'gpt-x',
      providerName: 'openai',
      serviceHub,
    }).catch(() => {})

    expect(models.stopAllModels).toHaveBeenCalledOnce()
    expect(models.stopAllModelsExcept).not.toHaveBeenCalled()
    expect(loaded.unloaded).toEqual([
      'llamacpp-upstream::shared-model',
      'mlx::broken-model',
    ])
    expect(loaded.snapshot()).toEqual({ 'llamacpp-upstream': [], 'mlx': [] })
  })

  it('leaves a model the user stopped down until it is asked for again', async () => {
    appState.userStoppedModels = []
    const models = {
      getActiveModels: vi.fn(async (provider?: string) =>
        provider === 'llamacpp-upstream' ? ['shared-model'] : []
      ),
      stopAllModels: vi.fn().mockResolvedValue(undefined),
    }
    const serviceHub = { models: () => models } as unknown as ServiceHub

    await stopAllLocalModelsByUser(serviceHub)

    expect(models.stopAllModels).toHaveBeenCalled()
    // Opening a chat must not load it straight back.
    expect(shouldAttemptAutoStart('llamacpp-upstream', 'shared-model')).toBe(
      false
    )
    // Only what was running is held down.
    expect(shouldAttemptAutoStart('llamacpp-upstream', 'other-model')).toBe(
      true
    )
    appState.userStoppedModels = []
  })

  it('records the stop before unloading, so an auto-start racing it stays out', async () => {
    appState.userStoppedModels = []
    let autoStartAllowedDuringUnload: boolean | undefined
    const models = {
      getActiveModels: vi.fn(async (provider?: string) =>
        provider === 'mlx' ? ['ready-model'] : []
      ),
      stopAllModels: vi.fn(async () => {
        autoStartAllowedDuringUnload = shouldAttemptAutoStart(
          'mlx',
          'ready-model'
        )
      }),
    }
    const serviceHub = { models: () => models } as unknown as ServiceHub

    await stopAllLocalModelsByUser(serviceHub)

    expect(autoStartAllowedDuringUnload).toBe(false)
    appState.userStoppedModels = []
  })

  it('lifts a hand stop when the user picks the model again', async () => {
    appState.userStoppedModels = ['mlx::ready-model']
    const models = {
      getActiveModels: vi.fn().mockResolvedValue(['ready-model']),
      stopAllModels: vi.fn().mockResolvedValue(undefined),
      stopAllModelsExcept: vi.fn().mockResolvedValue(undefined),
      startModel: vi.fn().mockResolvedValue(undefined),
    }
    const serviceHub = {
      app: () => ({
        getServerStatus: vi.fn().mockResolvedValue(false),
      }),
      models: () => models,
    } as unknown as ServiceHub

    await switchToModel({
      modelId: 'ready-model',
      providerName: 'mlx',
      serviceHub,
    })

    expect(appState.userStoppedModels).toEqual([])
    expect(shouldAttemptAutoStart('mlx', 'ready-model')).toBe(true)
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
      stopAllModelsExcept: vi.fn().mockResolvedValue(undefined),
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
      stopAllModelsExcept: vi.fn().mockResolvedValue(undefined),
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
      stopAllModelsExcept: vi.fn().mockResolvedValue(undefined),
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

// ATO-530: what the loading snackbar reads, and a Cancel that is the user's
// choice rather than a failure.
describe('load progress and cancel', () => {
  const cancelled = () =>
    Object.assign(new Error('The model load was cancelled.'), {
      code: 'MODEL_LOAD_CANCELLED',
    })

  const hubWith = (models: Record<string, unknown>) =>
    ({
      app: () => ({ getServerStatus: vi.fn().mockResolvedValue(false) }),
      models: () => ({
        getActiveModels: vi.fn().mockResolvedValue([]),
        stopAllModels: vi.fn().mockResolvedValue(undefined),
        stopAllModelsExcept: vi.fn().mockResolvedValue(undefined),
        stopModel: vi.fn().mockResolvedValue(undefined),
        cancelModelLoad: vi.fn().mockResolvedValue(true),
        ...models,
      }),
    }) as unknown as ServiceHub

  beforeEach(() => {
    vi.clearAllMocks()
    appState.serverStatus = 'stopped'
    appState.activeModels = []
    appState.userStoppedModels = []
    localApiState.enableOnStartup = false
    startServer.mockResolvedValue(1337)
    stopServer.mockResolvedValue(undefined)
    window.core = { api: { startServer, stopServer } } as typeof window.core
  })

  it('passes the steps the engine reports on to the status', async () => {
    localApiState.enableOnStartup = true
    const startModel = vi.fn(
      async (
        _provider: unknown,
        _model: string,
        _bypass: boolean,
        options: { onStage: (stage: unknown) => void }
      ) => {
        options.onStage({ kind: 'loadingWeights', cachedFraction: 0.98 })
      }
    )
    const serviceHub = hubWith({
      startModel,
      getActiveModels: vi.fn().mockResolvedValue(['ready-model']),
    })

    await switchToModel({ modelId: 'ready-model', providerName: 'mlx', serviceHub })

    expect(appState.setLoadingModelProgress.mock.calls.map(([p]) => p)).toEqual([
      { kind: 'loadingWeights', cachedFraction: 0.98, retry: undefined },
      { kind: 'startingServer' },
    ])
    localApiState.enableOnStartup = false
  })

  it('says it is unloading the model that was serving before loading the next', async () => {
    appState.activeModels = ['shared-model']
    const stopAllModelsExcept = vi.fn().mockResolvedValue(undefined)
    const startModel = vi.fn().mockResolvedValue(undefined)
    const serviceHub = hubWith({ stopAllModelsExcept, startModel })

    await switchToModel({ modelId: 'broken-model', providerName: 'mlx', serviceHub })

    expect(appState.setLoadingModelProgress).toHaveBeenCalledWith({
      kind: 'unloadingPrevious',
    })
    // The status reads as a restart of a serving engine, not a cold start.
    expect(appState.updateLoadingModel.mock.calls[0]).toEqual([
      true,
      { modelId: 'broken-model', kind: 'restart' },
    ])
    // The unload is the only step this load reports, and the status shows it
    // before the serving model goes down and before the next one loads.
    expect(appState.setLoadingModelProgress.mock.calls.map(([p]) => p)).toEqual([
      { kind: 'unloadingPrevious' },
    ])
    const [shownAt] = appState.setLoadingModelProgress.mock.invocationCallOrder
    expect(shownAt).toBeLessThan(stopAllModelsExcept.mock.invocationCallOrder[0])
    expect(shownAt).toBeLessThan(startModel.mock.invocationCallOrder[0])
    appState.activeModels = []
  })

  it('ends a cancelled load quietly, and keeps the model down', async () => {
    let rejectLoad: (error: unknown) => void = () => {}
    const cancelModelLoadInEngine = vi.fn(async () => {
      rejectLoad(cancelled())
      return true
    })
    const startModel = vi.fn(
      () =>
        new Promise((_, reject) => {
          rejectLoad = reject
        })
    )
    const serviceHub = hubWith({
      startModel,
      cancelModelLoad: cancelModelLoadInEngine,
    })

    const pending = switchToModel({
      modelId: 'ready-model',
      providerName: 'mlx',
      serviceHub,
    })
    const outcome = expect(pending).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
    })
    await vi.waitFor(() => expect(startModel).toHaveBeenCalled())
    await cancelModelLoad(serviceHub)
    await outcome

    expect(cancelModelLoadInEngine).toHaveBeenCalledWith('mlx', 'ready-model')

    expect(appState.setLoadingModelCancelling).toHaveBeenCalledWith(true)
    expect(toast.error).not.toHaveBeenCalled()
    // Selected, not loaded, and not brought back by the composer's auto-start.
    expect(shouldAttemptAutoStart('mlx', 'ready-model')).toBe(false)
    expect(appState.updateLoadingModel).toHaveBeenLastCalledWith(false)
  })

  it('unloads a model an engine loaded before the cancel could stop it', async () => {
    let finishLoad: () => void = () => {}
    const stopModel = vi.fn().mockResolvedValue(undefined)
    const startModel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLoad = resolve
        })
    )
    const serviceHub = hubWith({
      startModel,
      // This engine has no way to stop a load.
      cancelModelLoad: vi.fn().mockResolvedValue(false),
      stopModel,
    })

    const pending = switchToModel({
      modelId: 'ready-model',
      providerName: 'mlx',
      serviceHub,
    })
    const outcome = expect(pending).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
    })
    await vi.waitFor(() => expect(startModel).toHaveBeenCalled())
    await cancelModelLoad(serviceHub)
    finishLoad()
    await outcome

    expect(stopModel).toHaveBeenCalledWith('ready-model', 'mlx')
    expect(startServer).not.toHaveBeenCalled()
  })

  it('has nothing to cancel when no local load is running', async () => {
    const cancelInEngine = vi.fn()
    await cancelModelLoad(hubWith({ cancelModelLoad: cancelInEngine }))

    expect(cancelInEngine).not.toHaveBeenCalled()
    // Nothing is held down by a Cancel that had no load to stop.
    expect(appState.userStoppedModels).toEqual([])
  })

  it('unloads one model from the status dot and holds it down', async () => {
    const stopModel = vi.fn().mockResolvedValue(undefined)
    const serviceHub = hubWith({ stopModel })

    await unloadModelByUser({
      modelId: 'ready-model',
      providerName: 'mlx',
      serviceHub,
    })

    expect(stopModel).toHaveBeenCalledWith('ready-model', 'mlx')
    expect(shouldAttemptAutoStart('mlx', 'ready-model')).toBe(false)
    appState.userStoppedModels = []
  })

  describe('the selection after a load that did not come up', () => {
    const clearedSelection = () =>
      modelProviderState.selectModelProvider.mock.calls.filter(
        ([provider, model]) => provider === '' && model === ''
      )

    beforeEach(() => {
      modelProviderState.selectedProvider = 'mlx'
      modelProviderState.selectedModel = { id: 'ready-model' }
    })

    afterEach(() => {
      modelProviderState.selectedProvider = ''
      modelProviderState.selectedModel = null
    })

    it.each([false, true])(
      'clears the model that failed (auto-start=%s)',
      async (isAutoStart) => {
        const serviceHub = hubWith({
          startModel: vi.fn().mockRejectedValue(new Error('engine crashed')),
        })

        await expect(
          switchToModel({
            modelId: 'ready-model',
            providerName: 'mlx',
            serviceHub,
            isAutoStart,
          })
        ).rejects.toThrow('engine crashed')

        expect(clearedSelection()).toHaveLength(1)
      }
    )

    it('keeps a selection that moved on while the load was failing', async () => {
      modelProviderState.selectedModel = { id: 'other-model' }
      const serviceHub = hubWith({
        startModel: vi.fn().mockRejectedValue(new Error('engine crashed')),
      })

      await expect(
        switchToModel({ modelId: 'ready-model', providerName: 'mlx', serviceHub })
      ).rejects.toThrow('engine crashed')

      expect(clearedSelection()).toHaveLength(0)
    })

    it('keeps the selection when the user cancelled the load', async () => {
      let rejectLoad: (error: unknown) => void = () => {}
      const startModel = vi.fn(
        () =>
          new Promise((_, reject) => {
            rejectLoad = reject
          })
      )
      const serviceHub = hubWith({
        startModel,
        cancelModelLoad: vi.fn(async () => {
          rejectLoad(cancelled())
          return true
        }),
      })

      const pending = switchToModel({
        modelId: 'ready-model',
        providerName: 'mlx',
        serviceHub,
      })
      const outcome = expect(pending).rejects.toMatchObject({
        code: 'MODEL_LOAD_CANCELLED',
      })
      await vi.waitFor(() => expect(startModel).toHaveBeenCalled())
      await cancelModelLoad(serviceHub)
      await outcome

      expect(clearedSelection()).toHaveLength(0)
      appState.userStoppedModels = []
    })

    it('leaves the selection to a switch requested after the failing one', async () => {
      let rejectLoad: (error: unknown) => void = () => {}
      const startModel = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              rejectLoad = reject
            })
        )
        .mockResolvedValueOnce(undefined)
      const serviceHub = hubWith({ startModel })

      const failing = switchToModel({
        modelId: 'ready-model',
        providerName: 'mlx',
        serviceHub,
      })
      const failed = expect(failing).rejects.toThrow('engine crashed')
      await vi.waitFor(() => expect(startModel).toHaveBeenCalledOnce())
      // The user asks for the same model again while the first load runs.
      const retry = switchToModel({
        modelId: 'ready-model',
        providerName: 'mlx',
        serviceHub,
      })
      rejectLoad(new Error('engine crashed'))
      await failed
      await retry

      expect(startModel).toHaveBeenCalledTimes(2)
      expect(clearedSelection()).toHaveLength(0)
    })
  })
})

describe('selectThreadModelIfNone', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    modelProviderState.selectedProvider = ''
    modelProviderState.selectedModel = null
    // Mirrors the store here: the selection is what these cases check.
    modelProviderState.selectModelProvider.mockImplementation(
      (provider: string, modelId: string) => {
        modelProviderState.selectedProvider = provider
        modelProviderState.selectedModel = { id: modelId }
      }
    )
  })

  afterEach(() => {
    modelProviderState.selectModelProvider.mockReset()
    modelProviderState.selectedProvider = ''
    modelProviderState.selectedModel = null
  })

  it("points an empty composer back at the thread's model", () => {
    selectThreadModelIfNone({ id: 'broken-model', provider: 'mlx' })

    expect(modelProviderState.selectedProvider).toBe('mlx')
    expect(modelProviderState.selectedModel).toEqual({ id: 'broken-model' })
  })

  it('leaves a model the user picked since, and a thread with no model', () => {
    selectThreadModelIfNone(undefined)
    expect(modelProviderState.selectedModel).toBeNull()

    modelProviderState.selectedProvider = 'llamacpp-upstream'
    modelProviderState.selectedModel = { id: 'shared-model' }
    selectThreadModelIfNone({ id: 'broken-model', provider: 'mlx' })

    expect(modelProviderState.selectedProvider).toBe('llamacpp-upstream')
    expect(modelProviderState.selectedModel).toEqual({ id: 'shared-model' })
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

/**
 * The toast and compact picker status read the same classification.
 * `@/i18n/setup` is mocked to echo the key, so these pin which copy a given
 * engine error resolves to.
 */
describe('describeModelLoadFailure', () => {
  it('keeps a failure the user has to act on from expiring', () => {
    expect(
      describeModelLoadFailure(new Error('failed to allocate buffer'))
    ).toMatchObject({
      title: 'model-errors:outOfMemoryTitle',
      persistent: true,
    })
    expect(
      describeModelLoadFailure({ code: 'OS_VERSION_UNSUPPORTED' })
    ).toMatchObject({ persistent: true })
  })

  it('maps a classified engine code onto its own copy', () => {
    expect(
      describeModelLoadFailure({ code: 'MODEL_FILE_NOT_FOUND' })
    ).toMatchObject({
      title: 'model-errors:modelFileMissingTitle',
      description: 'model-errors:modelFileMissingDescription',
      persistent: false,
    })
    // A shard set missing members is an incomplete download by another name.
    expect(
      describeModelLoadFailure({ code: 'MODEL_SHARDS_INCOMPLETE' })
    ).toMatchObject({ title: 'model-errors:modelFileCorruptTitle' })
  })

  it('keeps the engine log behind the details toggle', () => {
    const failure = describeModelLoadFailure({
      code: 'MODEL_ARCH_NOT_SUPPORTED',
      message: 'Model architecture is not supported.',
      details: 'load_hparams: unknown model architecture',
    })

    expect(failure.title).toBe('model-errors:archNotSupportedTitle')
    expect(failure.details).toBe('load_hparams: unknown model architecture')
  })

  it('falls back to the engine reason for an unclassified failure', () => {
    const failure = describeModelLoadFailure(
      new Error('something the engine has never said before')
    )

    expect(failure.title).toBe('model-errors:modelLoadFailedTitle')
    expect(failure.persistent).toBe(false)
  })
})

describe('OOM retry ladder', () => {
  const oom = () =>
    Object.assign(new Error('failed to allocate buffer'), {
      code: 'OUT_OF_MEMORY',
    })

  const upstreamWith = (
    settings: Record<string, unknown>,
    providerSettings: unknown[] = []
  ) => {
    const list = modelProviderState.providers as Array<Record<string, unknown>>
    list[1] = {
      provider: 'llamacpp-upstream',
      settings: providerSettings,
      models: [
        {
          id: 'shared-model',
          settings: Object.fromEntries(
            Object.entries(settings).map(([key, value]) => [
              key,
              { key, controller_props: { value } },
            ])
          ),
        },
      ],
    }
    return list[1] as never
  }

  const modelSetting = (key: string) =>
    (
      (modelProviderState.providers[1] as Record<string, unknown>)
        .models as Array<{
        settings: Record<string, { controller_props: { value: unknown } }>
      }>
    )[0].settings[key]?.controller_props.value

  describe('planOomRetry', () => {
    it('halves the context down to the floor, then goes to the CPU, then gives up', () => {
      const provider = upstreamWith({ ctx_len: 16384, ngl: 100 })
      expect(planOomRetry(provider, 'shared-model', 0)).toEqual({
        kind: 'ctx',
        from: 16384,
        to: 8192,
      })
      expect(
        planOomRetry(
          upstreamWith({ ctx_len: 6000, ngl: 100 }),
          'shared-model',
          1
        )
      ).toEqual({ kind: 'ctx', from: 6000, to: 4096 })
      expect(
        planOomRetry(
          upstreamWith({ ctx_len: 4096, ngl: 100 }),
          'shared-model',
          2
        )
      ).toEqual({ kind: 'ngl', from: 100, to: 0 })
      expect(
        planOomRetry(upstreamWith({ ctx_len: 4096, ngl: 0 }), 'shared-model', 3)
      ).toBeNull()
    })

    it('under fit, widens the margin once and then stops', () => {
      // The engine already sized the context; fighting it re-OOMs.
      const fitOn = [
        { key: 'fit', controller_props: { value: true } },
        { key: 'fit_target', controller_props: { value: '1024' } },
      ]
      expect(
        planOomRetry(upstreamWith({ ctx_len: 16384 }, fitOn), 'shared-model', 0)
      ).toEqual({ kind: 'fit_target', from: 1024, to: 2048 })
      expect(
        planOomRetry(upstreamWith({ ctx_len: 16384 }, fitOn), 'shared-model', 1)
      ).toBeNull()
    })
  })

  it('reloads with a smaller context after an out-of-memory failure, and says so', async () => {
    upstreamWith({ ctx_len: 16384, ngl: 100 })
    const startModel = vi
      .fn()
      .mockRejectedValueOnce(oom())
      .mockRejectedValueOnce(oom())
      .mockResolvedValue(undefined)
    const models = {
      getActiveModels: vi.fn().mockResolvedValue(['shared-model']),
      stopAllModels: vi.fn().mockResolvedValue(undefined),
      stopAllModelsExcept: vi.fn().mockResolvedValue(undefined),
      startModel,
    }
    const serviceHub = {
      app: () => ({ getServerStatus: vi.fn().mockResolvedValue(false) }),
      models: () => models,
      providers: () => ({ updateSettings: vi.fn() }),
    } as unknown as ServiceHub

    await switchToModel({
      modelId: 'shared-model',
      providerName: 'llamacpp-upstream',
      serviceHub,
    })

    expect(startModel).toHaveBeenCalledTimes(3)
    // 16384 → 8192 → 4096, persisted on the model so the next launch starts
    // from what worked.
    expect(modelSetting('ctx_len')).toBe(4096)
    const posthog = (await import('posthog-js')).default
    const retries = vi
      .mocked(posthog.capture)
      .mock.calls.filter(([event]) => event === 'model_load_retry')
      .map(([, props]) => props as Record<string, unknown>)
    expect(retries.map((r) => [r.retry_step, r.retry_outcome])).toEqual([
      ['ctx', 'retrying'],
      ['ctx', 'retrying'],
      ['ctx', 'recovered'],
    ])
    expect(retries[0]).toMatchObject({ ctx_before: 16384, ctx_after: 8192 })
    const { toast } = await import('sonner')
    expect(toast.info).toHaveBeenCalledWith(
      'model-errors:oomRetryRecoveredTitle',
      expect.objectContaining({
        description: 'model-errors:oomRetryRecoveredContext',
      })
    )
  })

  it('gives up honestly once the ladder is spent', async () => {
    upstreamWith({ ctx_len: 4096, ngl: 0 })
    const startModel = vi.fn().mockRejectedValue(oom())
    const models = {
      getActiveModels: vi.fn().mockResolvedValue([]),
      stopAllModels: vi.fn().mockResolvedValue(undefined),
      stopAllModelsExcept: vi.fn().mockResolvedValue(undefined),
      startModel,
    }
    const serviceHub = {
      app: () => ({ getServerStatus: vi.fn().mockResolvedValue(false) }),
      models: () => models,
      providers: () => ({ updateSettings: vi.fn() }),
    } as unknown as ServiceHub

    await expect(
      switchToModel({
        modelId: 'shared-model',
        providerName: 'llamacpp-upstream',
        serviceHub,
      })
    ).rejects.toThrow('failed to allocate buffer')
    expect(startModel).toHaveBeenCalledTimes(1)
  })

  it('does not retry a failure that is not memory', async () => {
    upstreamWith({ ctx_len: 16384, ngl: 100 })
    const startModel = vi.fn().mockRejectedValue(new Error('unsupported arch'))
    const models = {
      getActiveModels: vi.fn().mockResolvedValue([]),
      stopAllModels: vi.fn().mockResolvedValue(undefined),
      stopAllModelsExcept: vi.fn().mockResolvedValue(undefined),
      startModel,
    }
    const serviceHub = {
      app: () => ({ getServerStatus: vi.fn().mockResolvedValue(false) }),
      models: () => models,
      providers: () => ({ updateSettings: vi.fn() }),
    } as unknown as ServiceHub

    await expect(
      switchToModel({
        modelId: 'shared-model',
        providerName: 'llamacpp-upstream',
        serviceHub,
      })
    ).rejects.toThrow('unsupported arch')
    expect(startModel).toHaveBeenCalledTimes(1)
    expect(modelSetting('ctx_len')).toBe(16384)
  })
})

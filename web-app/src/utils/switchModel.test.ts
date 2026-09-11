import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceHub } from '@/services'
import {
  isExplicitSwitchPending,
  planOomRetry,
  shouldAttemptAutoStart,
  splitModelLoadError,
  stopAllLocalModelsByUser,
  switchToModel,
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
      })
    ).rejects.toThrow('missing vision weights')

    expect(stopServer).toHaveBeenCalledOnce()
    expect(startServer).toHaveBeenCalledOnce()
    expect(appState.setServerStatus).toHaveBeenLastCalledWith('running')
  })

  it('keeps the target engine running and only unloads copies in other providers', async () => {
    // The same GGUF is loaded in both llama.cpp engines (post-download
    // auto-start landed in TurboQuant while the chat loaded upstream). A
    // switch to upstream must drop the TurboQuant copy only — never the
    // upstream server, which may be streaming an answer right now.
    const models = {
      getActiveModels: vi.fn(async (provider?: string) =>
        provider === 'llamacpp' || provider === 'llamacpp-upstream'
          ? ['shared-model']
          : []
      ),
      stopAllModels: vi.fn().mockResolvedValue(undefined),
      stopAllModelsExcept: vi.fn().mockResolvedValue(undefined),
      startModel: vi.fn().mockResolvedValue(undefined),
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
  })

  it('still stops every local engine when switching to a cloud model', async () => {
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

    await switchToModel({
      modelId: 'gpt-x',
      providerName: 'openai',
      serviceHub,
    }).catch(() => {})

    expect(models.stopAllModels).toHaveBeenCalledOnce()
    expect(models.stopAllModelsExcept).not.toHaveBeenCalled()
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ensureModelForServer } from '../ensureModelForServer'
import { useModelProvider } from '@/hooks/useModelProvider'

function makeProvider(
  provider: string,
  models: Array<{ id: string }>
): ModelProvider {
  return {
    provider,
    active: true,
    models,
  } as unknown as ModelProvider
}

describe('ensureModelForServer', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Awaits `ensureModelForServer`, fast-forwarding its internal 500ms settle delay. */
  async function run(
    ...args: Parameters<typeof ensureModelForServer>
  ): ReturnType<typeof ensureModelForServer> {
    const promise = ensureModelForServer(...args)
    await vi.advanceTimersByTimeAsync(500)
    return promise
  }

  it('returns already_loaded (via override provider name) when a model is already running and no override is given', async () => {
    const provider = makeProvider('llamacpp-upstream', [{ id: 'qwen3-4b' }])
    useModelProvider.setState({
      providers: [provider],
      selectedModel: null,
      selectedProvider: '',
    })

    const modelsService = {
      getActiveModels: vi.fn().mockResolvedValue(['qwen3-4b']),
      stopModel: vi.fn(),
      startModel: vi.fn(),
    }

    const result = await ensureModelForServer({ modelsService })

    expect(result).toEqual({
      status: 'already_loaded',
      modelId: 'qwen3-4b',
      providerName: 'llamacpp-upstream',
    })
    expect(modelsService.startModel).not.toHaveBeenCalled()
  })

  it('falls back to LOCAL_LLAMACPP_PROVIDER as providerName when the running model cannot be matched to a provider', async () => {
    useModelProvider.setState({
      providers: [],
      selectedModel: null,
      selectedProvider: '',
    })

    const modelsService = {
      getActiveModels: vi.fn().mockResolvedValue(['orphan-model']),
      stopModel: vi.fn(),
      startModel: vi.fn(),
    }

    const result = await ensureModelForServer({ modelsService })

    expect(result).toEqual({
      status: 'already_loaded',
      modelId: 'orphan-model',
      providerName: 'llamacpp-upstream',
    })
  })

  it('starts the auto-picked model when nothing is loaded', async () => {
    const provider = makeProvider('llamacpp-upstream', [{ id: 'qwen3-4b' }])
    useModelProvider.setState({
      providers: [provider],
      selectedModel: null,
      selectedProvider: '',
    })

    const modelsService = {
      getActiveModels: vi.fn().mockResolvedValue([]),
      stopModel: vi.fn(),
      startModel: vi.fn().mockResolvedValue(undefined),
    }
    const onLoadStart = vi.fn()
    const onLoadEnd = vi.fn()

    const result = await run({
      modelsService,
      onLoadStart,
      onLoadEnd,
    })

    expect(onLoadStart).toHaveBeenCalledTimes(1)
    expect(onLoadEnd).toHaveBeenCalledTimes(1)
    expect(modelsService.startModel).toHaveBeenCalledWith(
      provider,
      'qwen3-4b',
      true
    )
    expect(result).toEqual({
      status: 'loaded',
      modelId: 'qwen3-4b',
      providerName: 'llamacpp-upstream',
    })
  })

  it('calls onLoadEnd even when startModel throws', async () => {
    const provider = makeProvider('llamacpp-upstream', [{ id: 'qwen3-4b' }])
    useModelProvider.setState({
      providers: [provider],
      selectedModel: null,
      selectedProvider: '',
    })

    const modelsService = {
      getActiveModels: vi.fn().mockResolvedValue([]),
      stopModel: vi.fn(),
      startModel: vi.fn().mockRejectedValue(new Error('boom')),
    }
    const onLoadEnd = vi.fn()

    await expect(
      ensureModelForServer({ modelsService, onLoadEnd })
    ).rejects.toThrow('boom')
    expect(onLoadEnd).toHaveBeenCalledTimes(1)
  })

  it('returns no_model_available when nothing is loaded and no local model can be picked', async () => {
    useModelProvider.setState({
      providers: [],
      selectedModel: null,
      selectedProvider: '',
    })

    const modelsService = {
      getActiveModels: vi.fn().mockResolvedValue([]),
      stopModel: vi.fn(),
      startModel: vi.fn(),
    }

    const result = await ensureModelForServer({ modelsService })

    expect(result).toEqual({ status: 'no_model_available' })
    expect(modelsService.startModel).not.toHaveBeenCalled()
  })

  describe('modelOverride', () => {
    it('returns already_loaded and stops other running models when the override model is already running', async () => {
      const overrideProvider = makeProvider('llamacpp-upstream', [
        { id: 'target-model' },
      ])
      useModelProvider.setState({
        providers: [overrideProvider],
        selectedModel: null,
        selectedProvider: '',
      })

      const modelsService = {
        getActiveModels: vi
          .fn()
          .mockResolvedValue(['target-model', 'other-model']),
        stopModel: vi.fn().mockResolvedValue(undefined),
        startModel: vi.fn(),
      }

      const result = await ensureModelForServer({
        modelsService,
        modelOverride: { model: 'target-model', provider: 'llamacpp-upstream' },
      })

      expect(modelsService.stopModel).toHaveBeenCalledWith('other-model')
      expect(modelsService.stopModel).not.toHaveBeenCalledWith('target-model')
      expect(result).toEqual({
        status: 'already_loaded',
        modelId: 'target-model',
        providerName: 'llamacpp-upstream',
      })
    })

    it('stops all currently loaded models and starts the override model when it is not yet running', async () => {
      const overrideProvider = makeProvider('llamacpp-upstream', [
        { id: 'target-model' },
      ])
      useModelProvider.setState({
        providers: [overrideProvider],
        selectedModel: null,
        selectedProvider: '',
      })

      const modelsService = {
        getActiveModels: vi.fn().mockResolvedValue(['other-model']),
        stopModel: vi.fn().mockResolvedValue(undefined),
        startModel: vi.fn().mockResolvedValue(undefined),
      }

      const result = await run({
        modelsService,
        modelOverride: { model: 'target-model', provider: 'llamacpp-upstream' },
      })

      expect(modelsService.stopModel).toHaveBeenCalledWith('other-model')
      expect(modelsService.startModel).toHaveBeenCalledWith(
        overrideProvider,
        'target-model',
        true
      )
      expect(result).toEqual({
        status: 'loaded',
        modelId: 'target-model',
        providerName: 'llamacpp-upstream',
      })
    })

    it('starts the override model directly when nothing was loaded', async () => {
      const overrideProvider = makeProvider('llamacpp-upstream', [
        { id: 'target-model' },
      ])
      useModelProvider.setState({
        providers: [overrideProvider],
        selectedModel: null,
        selectedProvider: '',
      })

      const modelsService = {
        getActiveModels: vi.fn().mockResolvedValue([]),
        stopModel: vi.fn(),
        startModel: vi.fn().mockResolvedValue(undefined),
      }

      const result = await run({
        modelsService,
        modelOverride: { model: 'target-model', provider: 'llamacpp-upstream' },
      })

      expect(modelsService.stopModel).not.toHaveBeenCalled()
      expect(modelsService.startModel).toHaveBeenCalledWith(
        overrideProvider,
        'target-model',
        true
      )
      expect(result).toEqual({
        status: 'loaded',
        modelId: 'target-model',
        providerName: 'llamacpp-upstream',
      })
    })

    it('falls back to auto-pick when the override provider does not exist', async () => {
      const fallbackProvider = makeProvider('llamacpp-upstream', [
        { id: 'fallback-model' },
      ])
      useModelProvider.setState({
        providers: [fallbackProvider],
        selectedModel: null,
        selectedProvider: '',
      })

      const modelsService = {
        getActiveModels: vi.fn().mockResolvedValue([]),
        stopModel: vi.fn(),
        startModel: vi.fn().mockResolvedValue(undefined),
      }

      const result = await run({
        modelsService,
        modelOverride: { model: 'ghost-model', provider: 'ghost-provider' },
      })

      expect(modelsService.startModel).toHaveBeenCalledWith(
        fallbackProvider,
        'fallback-model',
        true
      )
      expect(result).toEqual({
        status: 'loaded',
        modelId: 'fallback-model',
        providerName: 'llamacpp-upstream',
      })
    })
  })
})

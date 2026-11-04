import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useHardware } from '@/hooks/useHardware'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { ServiceHub } from '@/services'

const mocks = vi.hoisted(() => ({
  getMaxCtxTrain: vi.fn<(id: string) => Promise<number | undefined>>(),
}))

vi.mock('@janhq/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@janhq/core')>()
  return {
    ...actual,
    EngineManager: {
      instance: () => ({
        get: () => ({ getMaxCtxTrain: mocks.getMaxCtxTrain }),
      }),
    },
  }
})

import {
  DEFAULT_CTX_LEN,
  contextGrowthMode,
  growModelContext,
  isGpuBackendBuild,
  readAutoIncreaseCtx,
  readModelCtxLen,
  readModelFitCtx,
  readProviderFitCtx,
  resetFailedFitFloors,
} from '../context-size'

function seedModel(ctxLen: number | undefined) {
  useModelProvider.setState({
    providers: [
      {
        provider: 'llamacpp-upstream',
        active: true,
        models: [
          {
            id: 'm',
            settings:
              ctxLen === undefined
                ? {}
                : { ctx_len: { controller_props: { value: ctxLen } } },
          },
        ],
        settings: [],
      },
    ] as never,
  })
}

function ctxLenInStore(): number | undefined {
  return readModelCtxLen(
    useModelProvider
      .getState()
      .providers.find((p) => p.provider === 'llamacpp-upstream')
      ?.models.find((m) => m.id === 'm') as never
  )
}

describe('readModelCtxLen / readAutoIncreaseCtx', () => {
  it('reads numeric and string ctx_len and defaults auto-increase to on', () => {
    expect(readModelCtxLen({ id: 'm', settings: { ctx_len: { controller_props: { value: 4096 } } } })).toBe(4096)
    expect(readModelCtxLen({ id: 'm', settings: { ctx_len: { controller_props: { value: '8192' } } } })).toBe(8192)
    expect(readModelCtxLen({ id: 'm', settings: {} })).toBeUndefined()
    expect(readAutoIncreaseCtx({ id: 'm' })).toBe(true)
    expect(
      readAutoIncreaseCtx({
        id: 'm',
        settings: { auto_increase_ctx_len: { controller_props: { value: false } } },
      })
    ).toBe(false)
  })
})

describe('growModelContext', () => {
  const stopModel = vi.fn().mockResolvedValue(undefined)
  const serviceHub = {
    models: () => ({ stopModel }),
  } as unknown as ServiceHub

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getMaxCtxTrain.mockResolvedValue(undefined)
  })

  it('steps the ladder once, writes ctx_len and unloads only this provider', async () => {
    seedModel(16384)
    const result = await growModelContext({
      providerId: 'llamacpp-upstream',
      modelId: 'm',
      serviceHub,
    })

    expect(result).toEqual({ ok: true, from: 16384, to: 32768 })
    expect(ctxLenInStore()).toBe(32768)
    expect(stopModel).toHaveBeenCalledWith('m', 'llamacpp-upstream')
  })

  it('keeps stepping until minCtxLen is reached', async () => {
    seedModel(16384)
    const result = await growModelContext({
      providerId: 'llamacpp-upstream',
      modelId: 'm',
      serviceHub,
      minCtxLen: 60_000,
    })

    // 16384 → 32768 → 49152 → 73728
    expect(result).toEqual({ ok: true, from: 16384, to: 73728 })
    expect(stopModel).toHaveBeenCalledTimes(1)
  })

  it('clamps at the training max and reports at_max once there', async () => {
    mocks.getMaxCtxTrain.mockResolvedValue(40_000)
    seedModel(16384)
    expect(
      await growModelContext({
        providerId: 'llamacpp-upstream',
        modelId: 'm',
        serviceHub,
        minCtxLen: 100_000,
      })
    ).toEqual({ ok: true, from: 16384, to: 40_000 })

    seedModel(40_000)
    expect(
      await growModelContext({
        providerId: 'llamacpp-upstream',
        modelId: 'm',
        serviceHub,
      })
    ).toEqual({ ok: false, reason: 'at_max', from: 40_000, max: 40_000 })
    expect(stopModel).toHaveBeenCalledTimes(1)
  })

  it('does not climb the ladder while the engine fits the context itself', async () => {
    // With `--fit` on, a bigger `ctx_size` is dropped by the argument builder
    // and the engine sizes the window again — a reload that changes nothing.
    seedModel(16384)
    const provider = useModelProvider
      .getState()
      .getProviderByName('llamacpp-upstream')!
    useModelProvider.getState().updateProvider('llamacpp-upstream', {
      settings: [
        {
          key: 'fit',
          title: 'Fit',
          description: '',
          controller_type: 'checkbox',
          controller_props: { value: true },
        },
        ...(provider.settings ?? []),
      ],
    })

    const result = await growModelContext({
      providerId: 'llamacpp-upstream',
      modelId: 'm',
      serviceHub,
    })
    expect(result).toEqual({ ok: false, reason: 'fit', from: 16384 })
    expect(stopModel).not.toHaveBeenCalled()
  })

  it('falls back to the default window when the model has no ctx_len', async () => {
    seedModel(undefined)
    const result = await growModelContext({
      providerId: 'llamacpp-upstream',
      modelId: 'm',
      serviceHub,
    })
    // The default is the one constant every fallback reads (ATO-465).
    expect(result).toEqual({ ok: true, from: DEFAULT_CTX_LEN, to: 32768 })
  })

  it('reports missing provider / model without touching the engine', async () => {
    seedModel(16384)
    expect(
      await growModelContext({ providerId: 'mlx', modelId: 'm', serviceHub })
    ).toEqual({ ok: false, reason: 'no_provider', from: 0 })
    expect(
      await growModelContext({
        providerId: 'llamacpp-upstream',
        modelId: 'other',
        serviceHub,
      })
    ).toEqual({ ok: false, reason: 'no_model', from: 0 })
    expect(stopModel).not.toHaveBeenCalled()
  })
})

describe('growModelContext under fit on a GPU build', () => {
  const stopModel = vi.fn().mockResolvedValue(undefined)
  const startModel = vi.fn().mockResolvedValue(undefined)
  const getSystemUsage = vi.fn()
  const serviceHub = {
    models: () => ({ stopModel, startModel }),
    hardware: () => ({ getSystemUsage }),
  } as unknown as ServiceHub

  function seedFit(opts: {
    backend: string
    ctxLen?: number
    modelFitCtx?: string
    providerFitCtx?: number
  }) {
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [
            {
              id: 'm',
              settings: {
                ...(opts.ctxLen === undefined
                  ? {}
                  : { ctx_len: { controller_props: { value: opts.ctxLen } } }),
                ...(opts.modelFitCtx === undefined
                  ? {}
                  : {
                      fit_ctx: {
                        key: 'fit_ctx',
                        controller_props: { value: opts.modelFitCtx },
                      },
                    }),
              },
            },
          ],
          settings: [
            { key: 'fit', controller_props: { value: true } },
            { key: 'version_backend', controller_props: { value: opts.backend } },
            ...(opts.providerFitCtx === undefined
              ? []
              : [{ key: 'fit_ctx', controller_props: { value: opts.providerFitCtx } }]),
          ],
        },
      ] as never,
    })
  }

  function modelSettings() {
    return useModelProvider
      .getState()
      .providers.find((p) => p.provider === 'llamacpp-upstream')
      ?.models.find((m) => m.id === 'm')?.settings as
      | Record<string, { controller_props?: { value?: unknown } }>
      | undefined
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetFailedFitFloors()
    mocks.getMaxCtxTrain.mockResolvedValue(131072)
    // 16 GiB free.
    getSystemUsage.mockResolvedValue({
      cpu: 0,
      used_memory: 16 * 1024,
      total_memory: 32 * 1024,
      gpus: [],
    })
    useHardware.setState({
      systemUsage: { cpu: 0, used_memory: 0, total_memory: 0, gpus: [] },
    })
  })

  it('raises the model-level fit_ctx one ladder step and reloads the model', async () => {
    seedFit({ backend: 'b11463/win-cuda-12.4-x64', ctxLen: 16384 })
    const result = await growModelContext({
      providerId: 'llamacpp-upstream',
      modelId: 'm',
      serviceHub,
    })

    expect(result).toEqual({ ok: true, from: 16384, to: 32768, via: 'fit_ctx' })
    // The string the core's llama.cpp config carries `fit_ctx` in.
    expect(modelSettings()?.fit_ctx?.controller_props?.value).toBe('32768')
    // The pre-flight of the retry reads the window it is about to get.
    expect(ctxLenInStore()).toBe(32768)
    expect(stopModel).toHaveBeenCalledWith('m', 'llamacpp-upstream')
    expect(startModel).toHaveBeenCalledTimes(1)
    expect(startModel.mock.calls[0][1]).toBe('m')
    // The reload reads the new floor from the store.
    const loadedWith = startModel.mock.calls[0][0] as {
      models: Array<{ id: string; settings: Record<string, { controller_props: { value: unknown } }> }>
    }
    expect(
      loadedWith.models.find((m) => m.id === 'm')?.settings.fit_ctx
        .controller_props.value
    ).toBe('32768')
  })

  it.each([
    'b11463/win-vulkan-x64',
    'b11463/linux-vulkan-x64',
    'b11463/win-hip-radeon-x64',
    'b11463/linux-rocm-6.2-x64',
    'b8000/win-cuda-13.3-x64',
  ])('grows the fit floor on %s', async (backend) => {
    seedFit({ backend, ctxLen: 8192 })
    expect(
      await growModelContext({ providerId: 'llamacpp-upstream', modelId: 'm', serviceHub })
    ).toMatchObject({ ok: true, via: 'fit_ctx', to: 32768 })
  })

  it.each(['b11463/win-cpu-x64', 'b11463/macos-arm64', 'b11463/linux-cpu-x64'])(
    'keeps the engine-sized window on %s, as before',
    async (backend) => {
      seedFit({ backend, ctxLen: 16384 })
      expect(
        await growModelContext({ providerId: 'llamacpp-upstream', modelId: 'm', serviceHub })
      ).toEqual({ ok: false, reason: 'fit', from: 16384 })
      expect(stopModel).not.toHaveBeenCalled()
      expect(modelSettings()?.fit_ctx).toBeUndefined()
    }
  )

  it('starts from the floor fit already keeps, and steps to minCtxLen at once', async () => {
    seedFit({
      backend: 'b11463/win-cuda-12.4-x64',
      ctxLen: 4096,
      modelFitCtx: '32768',
    })
    expect(
      await growModelContext({
        providerId: 'llamacpp-upstream',
        modelId: 'm',
        serviceHub,
        minCtxLen: 60_000,
      })
    ).toEqual({ ok: true, from: 32768, to: 73728, via: 'fit_ctx' })
    expect(startModel).toHaveBeenCalledTimes(1)
  })

  it('caps at the trained context', async () => {
    mocks.getMaxCtxTrain.mockResolvedValue(32768)
    seedFit({ backend: 'b11463/win-cuda-12.4-x64', ctxLen: 32768 })
    expect(
      await growModelContext({ providerId: 'llamacpp-upstream', modelId: 'm', serviceHub })
    ).toEqual({ ok: false, reason: 'at_max', from: 32768, max: 32768 })
    expect(stopModel).not.toHaveBeenCalled()
  })

  it('does not grow past the free system RAM', async () => {
    // 1 GiB free; 16384 → 32768 tokens needs ~2 GiB at the estimate.
    getSystemUsage.mockResolvedValue({
      cpu: 0,
      used_memory: 31 * 1024,
      total_memory: 32 * 1024,
      gpus: [],
    })
    seedFit({ backend: 'b11463/win-cuda-12.4-x64', ctxLen: 16384 })
    expect(
      await growModelContext({ providerId: 'llamacpp-upstream', modelId: 'm', serviceHub })
    ).toEqual({
      ok: false,
      reason: 'insufficient_memory',
      from: 16384,
      to: 32768,
      max: 131072,
    })
    expect(stopModel).not.toHaveBeenCalled()
    expect(modelSettings()?.fit_ctx).toBeUndefined()
  })

  it('falls back to the stored hardware reading, and just tries without one', async () => {
    getSystemUsage.mockResolvedValue(null)
    useHardware.setState({
      systemUsage: { cpu: 0, used_memory: 31 * 1024, total_memory: 32 * 1024, gpus: [] },
    })
    seedFit({ backend: 'b11463/win-cuda-12.4-x64', ctxLen: 16384 })
    expect(
      await growModelContext({ providerId: 'llamacpp-upstream', modelId: 'm', serviceHub })
    ).toMatchObject({ ok: false, reason: 'insufficient_memory' })

    useHardware.setState({
      systemUsage: { cpu: 0, used_memory: 0, total_memory: 0, gpus: [] },
      hardwareData: { ...useHardware.getState().hardwareData, ram: undefined },
    })
    expect(
      await growModelContext({ providerId: 'llamacpp-upstream', modelId: 'm', serviceHub })
    ).toMatchObject({ ok: true, via: 'fit_ctx' })
  })

  it('puts the previous floor back when the reload fails, and does not retry it', async () => {
    startModel.mockRejectedValueOnce(new Error('failed to allocate buffer'))
    seedFit({
      backend: 'b11463/win-cuda-12.4-x64',
      ctxLen: 16384,
      modelFitCtx: '8192',
    })
    expect(
      await growModelContext({ providerId: 'llamacpp-upstream', modelId: 'm', serviceHub })
    ).toEqual({
      ok: false,
      reason: 'reload_failed',
      from: 16384,
      to: 32768,
      max: 131072,
    })
    expect(modelSettings()?.fit_ctx?.controller_props?.value).toBe('8192')
    expect(ctxLenInStore()).toBe(16384)

    // The same floor again would only fail again.
    expect(
      await growModelContext({ providerId: 'llamacpp-upstream', modelId: 'm', serviceHub })
    ).toMatchObject({ ok: false, reason: 'reload_failed' })
    expect(startModel).toHaveBeenCalledTimes(1)
  })

  it('removes a floor the model did not have before a failed reload', async () => {
    startModel.mockRejectedValueOnce(new Error('load failed'))
    seedFit({ backend: 'b11463/win-vulkan-x64', ctxLen: 16384 })
    await growModelContext({ providerId: 'llamacpp-upstream', modelId: 'm', serviceHub })
    expect(modelSettings()?.fit_ctx).toBeUndefined()
  })
})

describe('contextGrowthMode / isGpuBackendBuild / fit floors', () => {
  const provider = (settings: Array<{ key: string; value: unknown }>) => ({
    provider: 'llamacpp-upstream',
    settings: settings.map(({ key, value }) => ({
      key,
      controller_props: { value },
    })),
  })

  it('reads the regime from fit and the configured build', () => {
    expect(contextGrowthMode(provider([{ key: 'fit', value: false }]))).toBe('ctx_len')
    expect(
      contextGrowthMode(
        provider([
          { key: 'fit', value: true },
          { key: 'version_backend', value: 'b1/win-cuda-12.4-x64' },
        ])
      )
    ).toBe('fit_ctx')
    expect(
      contextGrowthMode(
        provider([
          { key: 'fit', value: true },
          { key: 'version_backend', value: 'b1/macos-arm64' },
        ])
      )
    ).toBe('fixed')
    expect(contextGrowthMode(provider([{ key: 'fit', value: true }]))).toBe('fixed')
    expect(
      contextGrowthMode({ provider: 'mlx', settings: [] })
    ).toBe('ctx_len')
  })

  it('knows GPU builds by their backend id', () => {
    expect(isGpuBackendBuild('b11463/win-cuda-12.4-x64')).toBe(true)
    expect(isGpuBackendBuild('linux-vulkan-x64')).toBe(true)
    expect(isGpuBackendBuild('b1/win-hip-radeon-x64')).toBe(true)
    expect(isGpuBackendBuild('b1/linux-rocm-6.2-x64')).toBe(true)
    expect(isGpuBackendBuild('b1/win-cpu-x64')).toBe(false)
    expect(isGpuBackendBuild('b1/macos-arm64')).toBe(false)
    expect(isGpuBackendBuild('b1/win-opencl-adreno-arm64')).toBe(false)
    expect(isGpuBackendBuild(undefined)).toBe(false)
  })

  it('reads fit floors as numbers or strings', () => {
    expect(readModelFitCtx({ id: 'm', settings: { fit_ctx: { controller_props: { value: '8192' } } } })).toBe(8192)
    expect(readModelFitCtx({ id: 'm', settings: {} })).toBeUndefined()
    expect(readProviderFitCtx(provider([{ key: 'fit_ctx', value: 4096 }]))).toBe(4096)
    expect(readProviderFitCtx(provider([{ key: 'fit_ctx', value: '' }]))).toBe(4096)
    expect(readProviderFitCtx(provider([{ key: 'fit_ctx', value: '16384' }]))).toBe(16384)
  })
})

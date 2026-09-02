import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  growModelContext,
  readAutoIncreaseCtx,
  readModelCtxLen,
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

  it('falls back to the default window when the model has no ctx_len', async () => {
    seedModel(undefined)
    const result = await growModelContext({
      providerId: 'llamacpp-upstream',
      modelId: 'm',
      serviceHub,
    })
    expect(result).toEqual({ ok: true, from: 8192, to: 32768 })
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

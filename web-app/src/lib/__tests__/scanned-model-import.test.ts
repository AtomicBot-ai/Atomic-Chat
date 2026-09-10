import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelProvider } from '@/hooks/useModelProvider'
import {
  importScannedModel,
  pickSmallestRunnable,
  providerForScannedModel,
} from '@/lib/scanned-model-import'
import type { ServiceHub } from '@/services'
import type { LocalModelCandidate } from '@/services/models/localScan'

const mocks = vi.hoisted(() => ({
  engineImport: vi.fn(),
  engine: null as { import: (...args: unknown[]) => Promise<void> } | null,
}))

vi.mock('@janhq/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@janhq/core')>()),
  EngineManager: {
    instance: () => ({ get: () => mocks.engine }),
  },
}))

const cand = (
  id: string,
  runnable = true,
  sizeBytes?: number,
  format: LocalModelCandidate['format'] = 'gguf'
): LocalModelCandidate => ({
  id,
  displayName: `${id}.gguf`,
  path: `/models/${id}.gguf`,
  format,
  source: 'lmstudio',
  runnable,
  sizeBytes,
})

describe('pickSmallestRunnable', () => {
  it('takes the lightest runnable candidate, unsized ones last', () => {
    expect(
      pickSmallestRunnable([
        cand('big', true, 9e9),
        cand('small', true, 1e9),
        cand('unsized', true),
      ])?.id
    ).toBe('small')
    // A measured model always beats an unmeasured one.
    expect(pickSmallestRunnable([cand('unsized'), cand('known', true, 9e9)])?.id).toBe(
      'known'
    )
  })

  it('returns null when nothing can run', () => {
    expect(pickSmallestRunnable([cand('adapter', false, 1)])).toBeNull()
    expect(pickSmallestRunnable([])).toBeNull()
  })
})

describe('providerForScannedModel', () => {
  it('routes MLX folders to the MLX engine and everything else to llama.cpp', () => {
    expect(providerForScannedModel(cand('m', true, 1, 'mlx'))).toBe('mlx')
    expect(providerForScannedModel(cand('g'))).toBe('llamacpp-upstream')
  })
})

describe('importScannedModel', () => {
  const getProviders = vi.fn()
  const serviceHub = {
    providers: () => ({ getProviders }),
  } as unknown as ServiceHub

  beforeEach(() => {
    mocks.engineImport.mockReset()
    mocks.engine = { import: mocks.engineImport }
    getProviders.mockReset()
    useModelProvider.setState({ providers: [] })
  })

  it('imports without copying and refreshes the provider list', async () => {
    mocks.engineImport.mockResolvedValue(undefined)
    const refreshed = [
      {
        provider: 'llamacpp-upstream',
        active: true,
        settings: [],
        models: [{ id: 'small' }],
      },
    ] as unknown as ModelProvider[]
    getProviders.mockResolvedValue(refreshed)

    const result = await importScannedModel(
      { ...cand('small', true, 1e9), mmprojPath: '/models/small.mmproj' },
      serviceHub
    )

    expect(mocks.engineImport).toHaveBeenCalledWith('small', {
      modelPath: '/models/small.gguf',
      mmprojPath: '/models/small.mmproj',
      source: 'lmstudio',
    })
    expect(result).toEqual({ providerName: 'llamacpp-upstream', modelId: 'small' })
    expect(useModelProvider.getState().providers).toMatchObject([
      { provider: 'llamacpp-upstream', models: [{ id: 'small' }] },
    ])
  })

  it('fails loudly when the engine is not registered', async () => {
    mocks.engine = null
    await expect(importScannedModel(cand('x'), serviceHub)).rejects.toThrow(
      'Engine llamacpp-upstream not available'
    )
    expect(getProviders).not.toHaveBeenCalled()
  })
})

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '@/services/models/types'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).IS_MACOS = true
  ;(globalThis as Record<string, unknown>).IS_WINDOWS = false
})

const mocks = vi.hoisted(() => ({
  fetchHuggingFaceRepo: vi.fn(),
  convertHfRepoToCatalogModel: vi.fn(),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (
    selector: (state: { huggingfaceToken: undefined }) => unknown
  ) => selector({ huggingfaceToken: undefined }),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    models: () => ({
      fetchHuggingFaceRepo: mocks.fetchHuggingFaceRepo,
      convertHfRepoToCatalogModel: mocks.convertHfRepoToCatalogModel,
    }),
  }),
}))

type StoreRecommendation = {
  model_name: string
  description_key: string
  quant?: string
  mmproj_quant?: string
}

vi.mock('@/stores/recommended-models-registry-store', () => ({
  useRecommendedModelsRegistryStore: (
    selector: (state: {
      recommendations: StoreRecommendation[]
      lowSpecRecommendations: StoreRecommendation[]
    }) => unknown
  ) =>
    selector({
      recommendations: [
        {
          model_name: 'AtomicChat/remount-model-GGUF',
          description_key: 'hub:recEverydayUse',
        },
      ],
      lowSpecRecommendations: [
        {
          model_name: 'LiquidAI/LFM2.5-VL-450M-GGUF',
          description_key: 'hub:recVisionKnowledge',
          quant: 'Q8_0',
          mmproj_quant: 'Q8_0',
        },
      ],
    }),
}))

import { useResolvedRecommendedModels } from '../useResolvedRecommendedModels'

describe('useResolvedRecommendedModels', () => {
  beforeEach(() => {
    mocks.fetchHuggingFaceRepo.mockReset()
    mocks.convertHfRepoToCatalogModel.mockReset()
  })

  it('retains resolved cards across route remounts', async () => {
    const model: CatalogModel = {
      model_name: 'AtomicChat/remount-model-GGUF',
      developer: 'AtomicChat',
      downloads: 1,
      quants: [
        {
          model_id: 'AtomicChat/remount-model-Q4_K_M',
          path: 'https://example.com/model.gguf',
          file_size: '1 GB',
        },
      ],
    }
    mocks.fetchHuggingFaceRepo.mockResolvedValue({ id: model.model_name })
    mocks.convertHfRepoToCatalogModel.mockReturnValue(model)

    const first = renderHook(() => useResolvedRecommendedModels([]))

    await waitFor(() => {
      expect(mocks.fetchHuggingFaceRepo).toHaveBeenCalledOnce()
    })
    await waitFor(() => {
      expect(first.result.current[0]?.model).toEqual({
        ...model,
        is_mlx: false,
      })
    })
    first.unmount()

    const second = renderHook(() => useResolvedRecommendedModels([]))

    expect(second.result.current[0]?.model).toEqual({
      ...model,
      is_mlx: false,
    })
    expect(mocks.fetchHuggingFaceRepo).toHaveBeenCalledOnce()
  })
})

describe('useResolvedRecommendedModels hardware tiers', () => {
  beforeEach(() => {
    mocks.fetchHuggingFaceRepo.mockReset()
    mocks.convertHfRepoToCatalogModel.mockReset()
    mocks.fetchHuggingFaceRepo.mockResolvedValue(null)
  })

  it('defaults to the standard list', () => {
    const { result } = renderHook(() => useResolvedRecommendedModels([]))

    expect(result.current.map((i) => i.rec.modelName)).toEqual([
      'AtomicChat/remount-model-GGUF',
    ])
  })

  it('replaces the list entirely on a low-spec machine', () => {
    // Replace, not supplement: a machine that cannot run the standard pair is
    // not helped by seeing them alongside the small ones.
    const { result } = renderHook(() =>
      useResolvedRecommendedModels([], 'low')
    )

    expect(result.current.map((i) => i.rec.modelName)).toEqual([
      'LiquidAI/LFM2.5-VL-450M-GGUF',
    ])
  })

  it('carries the quant pins onto the resolved recommendation', () => {
    // Both are needed downstream: the repo also ships Q4_K_M weights and a
    // BF16 projector, so a dropped pin downloads the wrong files silently.
    const { result } = renderHook(() =>
      useResolvedRecommendedModels([], 'low')
    )

    expect(result.current[0].rec.quant).toBe('Q8_0')
    expect(result.current[0].rec.mmprojQuant).toBe('Q8_0')
  })
})

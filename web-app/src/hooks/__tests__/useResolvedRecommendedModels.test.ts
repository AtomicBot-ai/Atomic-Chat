import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BASELINE_TIER_RECOMMENDATIONS } from '@/constants/models'
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

const OVERRIDDEN_TIER = 'vram_8'
const BARE_TIER = 'vram_2'

vi.mock('@/stores/recommended-models-registry-store', () => ({
  useRecommendedModelsRegistryStore: (
    selector: (state: {
      recommendations: StoreRecommendation[]
      tiers: Record<string, StoreRecommendation[]>
    }) => unknown
  ) =>
    selector({
      // The flat list is the "other options" pool, not the lead offer.
      recommendations: [
        {
          model_name: 'AtomicChat/other-option-GGUF',
          description_key: 'hub:recEverydayUse',
        },
      ],
      tiers: {
        [OVERRIDDEN_TIER]: [
          {
            model_name: 'AtomicChat/remount-model-GGUF',
            description_key: 'hub:recVisionKnowledge',
            quant: 'Q8_0',
            mmproj_quant: 'Q8_0',
          },
        ],
      },
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

    const first = renderHook(() =>
      useResolvedRecommendedModels([], OVERRIDDEN_TIER)
    )

    await waitFor(() => {
      expect(first.result.current[0]?.model).toEqual({
        ...model,
        is_mlx: false,
      })
    })
    const fetchCount = mocks.fetchHuggingFaceRepo.mock.calls.length
    first.unmount()

    const second = renderHook(() =>
      useResolvedRecommendedModels([], OVERRIDDEN_TIER)
    )

    expect(second.result.current[0]?.model).toEqual({
      ...model,
      is_mlx: false,
    })
    expect(mocks.fetchHuggingFaceRepo).toHaveBeenCalledTimes(fetchCount)
  })
})

describe('useResolvedRecommendedModels hardware tiers', () => {
  beforeEach(() => {
    mocks.fetchHuggingFaceRepo.mockReset()
    mocks.convertHfRepoToCatalogModel.mockReset()
    mocks.fetchHuggingFaceRepo.mockResolvedValue(null)
  })

  it('leads with the tier the manifest overrides, then the other options', () => {
    // Order is the contract: the first screen renders index 0 as the offer and
    // hides the rest behind a disclosure.
    const { result } = renderHook(() =>
      useResolvedRecommendedModels([], OVERRIDDEN_TIER)
    )

    expect(result.current.map((i) => i.rec.modelName)).toEqual([
      'AtomicChat/remount-model-GGUF',
      'AtomicChat/other-option-GGUF',
    ])
  })

  it('falls back to the bundled ladder for a tier the manifest omits', () => {
    // A manifest may override one rung and leave the rest alone; the omitted
    // rungs must still lead with a real model rather than with the flat list.
    const { result } = renderHook(() =>
      useResolvedRecommendedModels([], BARE_TIER)
    )

    expect(result.current[0].rec.modelName).toBe(
      BASELINE_TIER_RECOMMENDATIONS[BARE_TIER][0].model_name
    )
    expect(result.current.map((i) => i.rec.modelName)).toContain(
      'AtomicChat/other-option-GGUF'
    )
  })

  it('carries the quant pins onto the resolved recommendation', () => {
    // Both are needed downstream: repos routinely ship several four-bit quants
    // and more than one projector, so a dropped pin downloads a
    // working-but-wrong file and fails nowhere.
    const { result } = renderHook(() =>
      useResolvedRecommendedModels([], OVERRIDDEN_TIER)
    )

    expect(result.current[0].rec.quant).toBe('Q8_0')
    expect(result.current[0].rec.mmprojQuant).toBe('Q8_0')
  })

  it('never repeats a model between the offer and the other options', () => {
    const { result } = renderHook(() =>
      useResolvedRecommendedModels([], BARE_TIER)
    )

    const names = result.current.map((i) => i.rec.modelName)
    expect(new Set(names).size).toBe(names.length)
  })
})

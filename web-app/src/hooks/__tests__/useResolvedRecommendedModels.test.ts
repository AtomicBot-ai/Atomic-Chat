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

import type { HardwareProfile, HardwareTier } from '@/lib/hardware-tier'
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

describe('useResolvedRecommendedModels memory ceiling', () => {
  const GIB = 1024
  const mac16: HardwareProfile = {
    tier: 'unified_16',
    memoryKind: 'unified',
    budgetMib: 16 * GIB,
    systemRamMib: 16 * GIB,
    vramMib: 0,
    hardCeiling: true,
  }

  /** A catalog card for a rung's lead, with its pinned quant at `size`. */
  const cardFor = (tier: HardwareTier, size: string) => {
    const lead = BASELINE_TIER_RECOMMENDATIONS[tier][0]
    const model: CatalogModel = {
      model_name: lead.model_name,
      developer: 'AtomicChat',
      downloads: 1,
      quants: [
        {
          model_id: `${lead.model_name.split('/')[1]}-${lead.quant}`,
          path: 'https://example.com/model.gguf',
          file_size: size,
        },
      ],
    }
    return model
  }

  beforeEach(() => {
    mocks.fetchHuggingFaceRepo.mockReset()
    mocks.convertHfRepoToCatalogModel.mockReset()
    mocks.fetchHuggingFaceRepo.mockResolvedValue(null)
  })

  it('steps down a rung when its own model would not load here', () => {
    // 15 GB on a 16 GiB Mac is past the measured 0.85 ceiling: Metal refuses
    // the allocation, so leading with it would be a warning, not an offer.
    const { result } = renderHook(() =>
      useResolvedRecommendedModels(
        [cardFor('unified_16', '15 GB'), cardFor('unified_8', '1.5 GB')],
        'unified_16',
        mac16
      )
    )

    expect(result.current[0].rec.modelName).toBe(
      BASELINE_TIER_RECOMMENDATIONS.unified_8[0].model_name
    )
  })

  it('keeps the rung when the model fits', () => {
    const { result } = renderHook(() =>
      useResolvedRecommendedModels(
        [cardFor('unified_16', '2.5 GB')],
        'unified_16',
        mac16
      )
    )

    expect(result.current[0].rec.modelName).toBe(
      BASELINE_TIER_RECOMMENDATIONS.unified_16[0].model_name
    )
  })

  it('steps an 18 GB Mac from the 27B down to the 16 GiB rung', () => {
    // 18 GB lands on unified_24, whose 27B at 15.4 GiB is 0.86 of the pool —
    // just past the ceiling — so the offer is the 16 GiB rung's instead.
    const mac18: HardwareProfile = {
      ...mac16,
      tier: 'unified_24',
      budgetMib: 18 * GIB,
      systemRamMib: 18 * GIB,
    }
    const { result } = renderHook(() =>
      useResolvedRecommendedModels(
        [cardFor('unified_24', '15.41 GB'), cardFor('unified_16', '6.42 GB')],
        'unified_24',
        mac18
      )
    )

    expect(result.current[0].rec.modelName).toBe(
      BASELINE_TIER_RECOMMENDATIONS.unified_16[0].model_name
    )
  })

  it('keeps the 27B on a 24 GB Mac', () => {
    const mac24: HardwareProfile = {
      ...mac16,
      tier: 'unified_24',
      budgetMib: 24 * GIB,
      systemRamMib: 24 * GIB,
    }
    const { result } = renderHook(() =>
      useResolvedRecommendedModels(
        [cardFor('unified_24', '15.41 GB')],
        'unified_24',
        mac24
      )
    )

    expect(result.current[0].rec.modelName).toBe(
      BASELINE_TIER_RECOMMENDATIONS.unified_24[0].model_name
    )
  })

  it('does not demote on a guess: an unresolved card keeps its rung', () => {
    const { result } = renderHook(() =>
      useResolvedRecommendedModels([], 'unified_16', mac16)
    )

    expect(result.current[0].rec.modelName).toBe(
      BASELINE_TIER_RECOMMENDATIONS.unified_16[0].model_name
    )
  })

  it('never demotes a card, where overshoot is a slowdown rather than a wall', () => {
    const pc: HardwareProfile = {
      ...mac16,
      tier: 'vram_16',
      memoryKind: 'vram',
      vramMib: 16 * GIB,
      hardCeiling: false,
    }
    const lead = BASELINE_TIER_RECOMMENDATIONS.vram_16[0]
    const { result } = renderHook(() =>
      useResolvedRecommendedModels(
        [
          {
            model_name: lead.model_name,
            developer: 'AtomicChat',
            downloads: 1,
            quants: [
              {
                model_id: `x-${lead.quant}`,
                path: 'https://example.com/model.gguf',
                file_size: '40 GB',
              },
            ],
          },
        ],
        'vram_16',
        pc
      )
    )

    expect(result.current[0].rec.modelName).toBe(lead.model_name)
  })
})

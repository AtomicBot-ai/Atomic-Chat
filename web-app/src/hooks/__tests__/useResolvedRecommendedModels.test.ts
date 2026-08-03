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

vi.mock('@/stores/recommended-models-registry-store', () => ({
  useRecommendedModelsRegistryStore: (
    selector: (state: {
      recommendations: Array<{
        model_name: string
        description_key: string
      }>
    }) => unknown
  ) =>
    selector({
      recommendations: [
        {
          model_name: 'AtomicChat/remount-model-GGUF',
          description_key: 'hub:recEverydayUse',
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

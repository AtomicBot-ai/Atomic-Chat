import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '@/services/models/types'
import type { StaffPick } from '@/services/staff-picks-registry'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).IS_MACOS = true
  ;(globalThis as Record<string, unknown>).IS_WINDOWS = false
})

const mocks = vi.hoisted(() => ({
  fetchHuggingFaceRepo: vi.fn(),
  convertHfRepoToCatalogModel: vi.fn(),
  picks: [] as StaffPick[],
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

vi.mock('@/stores/staff-picks-store', () => ({
  useStaffPicksStore: (selector: (state: { picks: StaffPick[] }) => unknown) =>
    selector({ picks: mocks.picks }),
}))

import { __resetStaffPickResolutionCache, useStaffPicks } from '../useStaffPicks'

const catalogModel = (name: string): CatalogModel => ({
  model_name: name,
  developer: name.split('/')[0],
  downloads: 1,
  quants: [
    {
      model_id: `${name}-Q4_K_M`,
      path: 'https://example.com/model.gguf',
      file_size: '1 GB',
    },
  ],
})

describe('useStaffPicks', () => {
  beforeEach(() => {
    mocks.fetchHuggingFaceRepo.mockReset()
    mocks.convertHfRepoToCatalogModel.mockReset()
    mocks.picks = []
    __resetStaffPickResolutionCache()
  })

  it('resolves a pick from the curated catalog without hitting Hugging Face', () => {
    mocks.picks = [{ model_name: 'AtomicChat/in-catalog-GGUF' }]
    const source = catalogModel('AtomicChat/in-catalog-GGUF')

    const { result } = renderHook(() => useStaffPicks([source]))

    expect(result.current[0].model).toBe(source)
    expect(mocks.fetchHuggingFaceRepo).not.toHaveBeenCalled()
  })

  it('fetches a missing repo from Hugging Face exactly once', async () => {
    mocks.picks = [{ model_name: 'AtomicChat/missing-GGUF' }]
    const model = catalogModel('AtomicChat/missing-GGUF')
    mocks.fetchHuggingFaceRepo.mockResolvedValue({ id: model.model_name })
    mocks.convertHfRepoToCatalogModel.mockReturnValue(model)

    const first = renderHook(() => useStaffPicks([]))

    await waitFor(() => {
      expect(first.result.current[0].model).toEqual({ ...model, is_mlx: false })
    })
    expect(mocks.fetchHuggingFaceRepo).toHaveBeenCalledOnce()

    first.unmount()
    const second = renderHook(() => useStaffPicks([]))

    expect(second.result.current[0].model).toEqual({ ...model, is_mlx: false })
    expect(mocks.fetchHuggingFaceRepo).toHaveBeenCalledOnce()
  })

  it('orders picks by order and drops inactive and off-platform entries', () => {
    mocks.picks = [
      { model_name: 'a/third', order: 30 },
      { model_name: 'a/first', order: 10 },
      { model_name: 'a/hidden', order: 20, active: false },
      { model_name: 'a/windows-only', order: 15, platforms: ['windows'] },
      { model_name: 'a/second', order: 20 },
    ]

    const { result } = renderHook(() => useStaffPicks([]))

    expect(result.current.map((i) => i.pick.model_name)).toEqual([
      'a/first',
      'a/second',
      'a/third',
    ])
  })

  it('resolves only the requested build format', () => {
    mocks.picks = [
      { model_name: 'a/gguf', format: 'gguf', order: 10 },
      {
        model_name: 'a/mlx',
        format: 'mlx',
        platforms: ['macos'],
        order: 15,
      },
    ]

    const gguf = renderHook(() => useStaffPicks([]))
    expect(gguf.result.current.map((i) => i.pick.model_name)).toEqual([
      'a/gguf',
    ])

    const mlx = renderHook(() => useStaffPicks([], 'mlx'))
    expect(mlx.result.current.map((i) => i.pick.model_name)).toEqual(['a/mlx'])
  })

  it('never looks up a pick belonging to the other format', () => {
    mocks.picks = [
      { model_name: 'a/mlx', format: 'mlx', platforms: ['macos'], order: 10 },
    ]
    mocks.fetchHuggingFaceRepo.mockResolvedValue(null)

    const { result } = renderHook(() => useStaffPicks([]))

    expect(result.current).toEqual([])
    expect(mocks.fetchHuggingFaceRepo).not.toHaveBeenCalled()
  })

  it('keeps unresolved picks in the list as placeholders', () => {
    mocks.picks = [{ model_name: 'a/unknown' }]
    mocks.fetchHuggingFaceRepo.mockResolvedValue(null)

    const { result } = renderHook(() => useStaffPicks([]))

    expect(result.current).toHaveLength(1)
    expect(result.current[0].model).toBeNull()
  })

  it('survives a failing Hugging Face lookup', async () => {
    mocks.picks = [{ model_name: 'a/explodes' }]
    mocks.fetchHuggingFaceRepo.mockRejectedValue(new Error('offline'))
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    const { result } = renderHook(() => useStaffPicks([]))

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalled()
    })
    expect(result.current[0].model).toBeNull()
    consoleError.mockRestore()
  })
})

describe('useStaffPicks on non-macOS hosts', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.fetchHuggingFaceRepo.mockReset()
    mocks.convertHfRepoToCatalogModel.mockReset()
    mocks.picks = []
  })

  it('drops an MLX pick that forgot to declare platforms', async () => {
    ;(globalThis as Record<string, unknown>).IS_MACOS = false
    ;(globalThis as Record<string, unknown>).IS_WINDOWS = true

    const module = await import('../useStaffPicks')
    module.__resetStaffPickResolutionCache()

    mocks.picks = [{ model_name: 'mlx-community/no-platforms' }]
    const mlxModel: CatalogModel = {
      ...catalogModel('mlx-community/no-platforms'),
      library_name: 'mlx',
    }
    mocks.fetchHuggingFaceRepo.mockResolvedValue({ id: mlxModel.model_name })
    mocks.convertHfRepoToCatalogModel.mockReturnValue(mlxModel)

    const { result } = renderHook(() => module.useStaffPicks([]))

    await waitFor(() => {
      expect(mocks.fetchHuggingFaceRepo).toHaveBeenCalledOnce()
    })
    expect(result.current[0].model).toBeNull()
    ;(globalThis as Record<string, unknown>).IS_MACOS = true
    ;(globalThis as Record<string, unknown>).IS_WINDOWS = false
  })
})

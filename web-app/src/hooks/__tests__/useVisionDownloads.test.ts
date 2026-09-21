import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelProvider } from '@/hooks/useModelProvider'
import type { HardwareProfile } from '@/lib/hardware-tier'
import type { CatalogModel } from '@/services/models/types'
import type { StaffPick } from '@/services/staff-picks-registry'

const mocks = vi.hoisted(() => ({
  pullModelWithMetadata: vi.fn(),
  addLocalDownloadingModel: vi.fn(),
  clearResumableDownload: vi.fn(),
  profile: null as HardwareProfile | null,
  recommended: [] as Array<{
    rec: {
      modelName: string
      descriptionKey: string
      quant?: string
      mmprojQuant?: string
    }
    model: CatalogModel | null
  }>,
  picks: [] as Array<{ pick: StaffPick; model: CatalogModel | null }>,
}))

vi.mock('@/hooks/useResolvedRecommendedModels', () => ({
  useResolvedRecommendedModels: () => mocks.recommended,
}))

vi.mock('@/hooks/useStaffPicks', () => ({
  useStaffPicks: () => mocks.picks,
}))

vi.mock('@/hooks/useModelSources', () => ({
  useModelSources: () => ({ sources: [] }),
}))

vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => ({
    tier: 'unified_16',
    profile: mocks.profile,
    ready: true,
  }),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (
    selector: (state: { huggingfaceToken: string }) => unknown
  ) => selector({ huggingfaceToken: '' }),
}))

vi.mock('@/hooks/useDownloadStore', () => {
  const state = {
    downloads: {},
    localDownloadingModels: new Set<string>(),
    resumableDownloads: new Set<string>(),
    addLocalDownloadingModel: mocks.addLocalDownloadingModel,
    clearResumableDownload: mocks.clearResumableDownload,
  }
  const useDownloadStore = (selector?: (value: typeof state) => unknown) =>
    selector ? selector(state) : state
  useDownloadStore.getState = () => state
  return { useDownloadStore }
})

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    models: () => ({ pullModelWithMetadata: mocks.pullModelWithMetadata }),
  }),
}))

import { useVisionDownloads } from '../useVisionDownloads'

/** A 16 GiB Mac: the Metal ceiling makes `wont_load` reachable. */
const MAC_16: HardwareProfile = {
  tier: 'unified_16',
  memoryKind: 'unified',
  budgetMib: 16 * 1024,
  systemRamMib: 16 * 1024,
  vramMib: 0,
  hardCeiling: true,
}

const card = (
  repo: string,
  sizeGb: number,
  options: { mmproj?: boolean; mlx?: boolean } = {}
): CatalogModel => {
  const slug = repo.split('/').pop() ?? repo
  return {
    model_name: repo,
    description: '',
    downloads: 0,
    is_mlx: options.mlx ?? false,
    quants: [
      {
        model_id: `${slug}-Q4_K_M`,
        path: `https://example.test/${slug}-Q4_K_M.gguf`,
        file_size: `${sizeGb} GB`,
      },
    ],
    mmproj_models: options.mmproj
      ? [
          {
            model_id: 'mmproj-f16',
            path: `https://example.test/${slug}-mmproj-f16.gguf`,
            file_size: '0.5 GB',
          },
        ]
      : [],
    num_mmproj: options.mmproj ? 1 : 0,
  }
}

const recommendedEntry = (
  model: CatalogModel | null,
  repo = model?.model_name ?? 'pending/repo',
  mmprojQuant?: string
) => ({
  rec: {
    modelName: repo,
    descriptionKey: 'hub:recVisionKnowledge',
    quant: 'Q4_K_M',
    ...(mmprojQuant ? { mmprojQuant } : {}),
  },
  model,
})

const pickEntry = (
  model: CatalogModel | null,
  repo = model?.model_name ?? 'pending/pick',
  title?: string
) => ({
  pick: {
    model_name: repo,
    title,
    description_key: 'hub:recVisionKnowledge',
    categories: ['vision' as const],
  },
  model,
})

const titles = (result: { current: { items: Array<{ title: string }> } }) =>
  result.current.items.map((item) => item.title)

describe('useVisionDownloads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.profile = MAC_16
    mocks.recommended = []
    mocks.picks = []
    useModelProvider.setState({ providers: [] })
  })

  it('offers only repos that ship a multimodal projector', () => {
    mocks.recommended = [
      recommendedEntry(card('AtomicChat/Qwen3.5-4B-GGUF', 2.5)),
      recommendedEntry(
        card('AtomicChat/gemma-4-E4B-it-GGUF', 4.5, { mmproj: true }),
        undefined,
        'F16'
      ),
    ]
    mocks.picks = [
      pickEntry(card('LiquidAI/LFM2.5-2.6B-GGUF', 1.6), undefined, 'LFM2.5'),
      pickEntry(
        card('AtomicChat/Qwen3.5-9B-GGUF', 5.5, { mmproj: true }),
        undefined,
        'Qwen3.5 9B'
      ),
    ]

    const { result } = renderHook(() => useVisionDownloads())

    expect(titles(result)).toEqual(['Gemma 4 E4B', 'Qwen3.5 9B'])
  })

  it('keeps GGUF builds only', () => {
    mocks.picks = [
      pickEntry(
        card('AtomicChat/Qwen3.6-27B-MLX-4bit', 15, {
          mmproj: true,
          mlx: true,
        }),
        undefined,
        'Qwen3.6 27B (MLX)'
      ),
      pickEntry(
        card('AtomicChat/gemma-4-E4B-it-GGUF', 4.5, { mmproj: true }),
        undefined,
        'Gemma 4 E4B'
      ),
    ]

    const { result } = renderHook(() => useVisionDownloads())

    expect(titles(result)).toEqual(['Gemma 4 E4B'])
  })

  it('drops rows that would not load here and leads with the best fit', () => {
    mocks.picks = [
      // Past the Metal ceiling on a 16 GiB Mac: never offered.
      pickEntry(
        card('AtomicChat/gemma-4-31B-it-GGUF', 18, { mmproj: true }),
        undefined,
        'Gemma 4 31B'
      ),
      // Loads, but tight: goes after the comfortable one.
      pickEntry(
        card('AtomicChat/gemma-4-12B-it-GGUF', 9, { mmproj: true }),
        undefined,
        'Gemma 4 12B'
      ),
      pickEntry(
        card('AtomicChat/gemma-4-E4B-it-GGUF', 4.5, { mmproj: true }),
        undefined,
        'Gemma 4 E4B'
      ),
    ]

    const { result } = renderHook(() => useVisionDownloads())

    expect(titles(result)).toEqual(['Gemma 4 E4B', 'Gemma 4 12B'])
  })

  it('lists a repo once even when the manifest and the picks both carry it', () => {
    const gemma = card('AtomicChat/gemma-4-E4B-it-GGUF', 4.5, { mmproj: true })
    mocks.recommended = [recommendedEntry(gemma, undefined, 'F16')]
    mocks.picks = [pickEntry(gemma, undefined, 'Gemma 4 E4B')]

    const { result } = renderHook(() => useVisionDownloads())

    expect(result.current.items).toHaveLength(1)
  })

  it('caps the list', () => {
    mocks.picks = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      pickEntry(
        card(`org/vision-${n}-GGUF`, 1, { mmproj: true }),
        undefined,
        `Vision ${n}`
      )
    )

    const { result } = renderHook(() => useVisionDownloads(3))

    expect(titles(result)).toEqual(['Vision 1', 'Vision 2', 'Vision 3'])
  })

  it('marks a model already on disk and puts it first', () => {
    mocks.picks = [
      pickEntry(
        card('AtomicChat/gemma-4-E4B-it-GGUF', 4.5, { mmproj: true }),
        undefined,
        'Gemma 4 E4B'
      ),
      pickEntry(
        card('AtomicChat/Qwen3.5-9B-GGUF', 5.5, { mmproj: true }),
        undefined,
        'Qwen3.5 9B'
      ),
    ]
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [{ id: 'Qwen3.5-9B-GGUF-Q4_K_M' }],
          settings: [],
        } as unknown as ModelProvider,
      ],
    })

    const { result } = renderHook(() => useVisionDownloads())

    expect(
      result.current.items.map((item) => [item.title, item.installed])
    ).toEqual([
      ['Qwen3.5 9B', true],
      ['Gemma 4 E4B', false],
    ])
  })

  it('reports loading while the sources are still resolving', () => {
    mocks.recommended = [recommendedEntry(null, 'AtomicChat/pending-GGUF')]

    const { result } = renderHook(() => useVisionDownloads())

    expect(result.current.items).toEqual([])
    expect(result.current.isLoading).toBe(true)
  })

  it('downloads the weights together with the pinned projector', () => {
    const gemma = card('AtomicChat/gemma-4-E4B-it-GGUF', 4.5, { mmproj: true })
    gemma.mmproj_models = [
      {
        model_id: 'mmproj-f16',
        path: 'https://example.test/mmproj-F16.gguf',
        file_size: '0.9 GB',
      },
      {
        model_id: 'mmproj-q8_0',
        path: 'https://example.test/mmproj-Q8_0.gguf',
        file_size: '0.5 GB',
      },
    ]
    mocks.recommended = [recommendedEntry(gemma, undefined, 'Q8_0')]

    const { result } = renderHook(() => useVisionDownloads())
    const started = result.current.items[0].start()

    expect(started).toBe('gemma-4-E4B-it-GGUF-Q4_K_M')
    expect(result.current.items[0].sizeLabel).toBe('5.0 GB')
    expect(mocks.pullModelWithMetadata).toHaveBeenCalledWith(
      'gemma-4-E4B-it-GGUF-Q4_K_M',
      'https://example.test/gemma-4-E4B-it-GGUF-Q4_K_M.gguf',
      'https://example.test/mmproj-Q8_0.gguf',
      '',
      true,
      false
    )
  })
})

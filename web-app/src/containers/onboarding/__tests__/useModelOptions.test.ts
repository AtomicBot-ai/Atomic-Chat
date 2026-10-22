import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HardwareProfile } from '@/lib/hardware-tier'
import type { LocalModelCandidate } from '@/services/models/localScan'
import type { CatalogModel } from '@/services/models/types'

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  recommended: [] as { rec: Record<string, unknown>; model: unknown }[],
  picks: [] as { pick: Record<string, unknown>; model: unknown }[],
  providers: [] as unknown[],
  profile: null as unknown,
  tierReady: true,
}))

vi.mock('@/services/models/localScan', () => ({
  scanLocalModels: mocks.scan,
  collectImportedModelPaths: () => [],
}))
vi.mock('@/services/models/downloadPreflight', () => ({
  getDownloadFreeSpace: async () => ({
    available: 84 * 1024 ** 3,
    headroom: 0,
  }),
}))
vi.mock('@/hooks/useResolvedRecommendedModels', () => ({
  useResolvedRecommendedModels: () => mocks.recommended,
}))
vi.mock('@/hooks/useStaffPicks', () => ({
  useStaffPicks: () => mocks.picks,
}))
vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => ({
    tier: 'unified_16',
    profile: mocks.profile,
    ready: mocks.tierReady,
  }),
}))
vi.mock('@/hooks/useModelSources', () => ({
  useModelSources: (select: (state: unknown) => unknown) =>
    select({ sources: [], fetchSources: async () => {}, loading: false }),
}))
vi.mock('@/stores/recommended-models-registry-store', () => ({
  useRecommendedModelsRegistryStore: { getState: () => ({ refresh: vi.fn() }) },
}))
vi.mock('@/stores/staff-picks-store', () => ({
  useStaffPicksStore: { getState: () => ({ refresh: vi.fn() }) },
}))

import { useHardware } from '@/hooks/useHardware'
import { useModelProvider } from '@/hooks/useModelProvider'

import { MODEL_INPUT_DEADLINE_MS, useModelOptions } from '../useModelOptions'

const gguf = (name: string, sizeGb: number): CatalogModel =>
  ({
    model_name: name,
    developer: name.split('/')[0],
    description: '',
    downloads: 0,
    quants: [
      {
        model_id: `${name.split('/')[1]}-Q4_K_M`,
        path: `https://huggingface.co/${name}/q4.gguf`,
        file_size: `${sizeGb} GB`,
      },
    ],
  }) as CatalogModel

const machine: HardwareProfile = {
  tier: 'unified_16',
  memoryKind: 'unified',
  budgetMib: 10 * 1024,
  systemRamMib: 16 * 1024,
  vramMib: 0,
  hardCeiling: true,
}

describe('model step options', () => {
  beforeEach(() => {
    vi.useRealTimers()
    mocks.scan.mockReset().mockResolvedValue([])
    mocks.profile = machine
    mocks.tierReady = true
    mocks.recommended = [
      {
        rec: { modelName: 'unsloth/Qwen3.5-4B' },
        model: gguf('unsloth/Qwen3.5-4B', 2.5),
      },
    ]
    mocks.picks = []
    useModelProvider.setState({ providers: [] } as never)
    useHardware.setState((state) => ({
      hardwareData: {
        ...state.hardwareData,
        cpu: { ...state.hardwareData.cpu, name: 'Apple M2' },
      },
    }))
  })

  it('waits for the on-disk scan before showing the list', async () => {
    let answer: (found: LocalModelCandidate[]) => void = () => {}
    mocks.scan.mockReturnValue(
      new Promise<LocalModelCandidate[]>((resolve) => {
        answer = resolve
      })
    )
    const { result } = renderHook(() => useModelOptions())
    expect(result.current.ready).toBe(false)

    await act(async () => answer([]))

    expect(result.current.ready).toBe(true)
  })

  it('stops waiting for a scan that never answers', async () => {
    vi.useFakeTimers()
    mocks.scan.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useModelOptions())

    await act(async () => {
      vi.advanceTimersByTime(MODEL_INPUT_DEADLINE_MS)
    })

    expect(result.current.ready).toBe(true)
    expect(result.current.detected).toEqual([])
  })

  it('leads with the tier offer, then picks this machine can run, four at most', async () => {
    mocks.picks = [
      { pick: { model_name: 'big/Huge-70B' }, model: gguf('big/Huge-70B', 40) },
      {
        pick: { model_name: 'google/Gemma-4B', title: 'Gemma 4B' },
        model: gguf('google/Gemma-4B', 3),
      },
      {
        pick: { model_name: 'meta/Llama-8B' },
        model: gguf('meta/Llama-8B', 5),
      },
      {
        pick: { model_name: 'mistral/Small-3B' },
        model: gguf('mistral/Small-3B', 2),
      },
      {
        pick: { model_name: 'ibm/Granite-2B' },
        model: gguf('ibm/Granite-2B', 1.5),
      },
      {
        pick: { model_name: 'unsloth/Qwen3.5-4B' },
        model: gguf('unsloth/Qwen3.5-4B', 2.5),
      },
    ]
    const { result } = renderHook(() => useModelOptions())
    await waitFor(() => expect(result.current.ready).toBe(true))

    const rows = result.current.recommended
    expect(rows.map((row) => row.title)).toHaveLength(4)
    expect(rows[0]).toMatchObject({
      catalog: { model_name: 'unsloth/Qwen3.5-4B' },
      bestFit: true,
      position: 0,
      taskId: 'Qwen3.5-4B-Q4_K_M',
      matchIds: ['Qwen3.5-4B-Q4_K_M', 'unsloth/Qwen3_5-4B-Q4_K_M'],
    })
    expect(rows.slice(1).every((row) => !row.bestFit)).toBe(true)
    expect(rows.some((row) => row.catalog.model_name === 'big/Huge-70B')).toBe(
      false
    )
    expect(rows.map((row) => row.position)).toEqual([0, 1, 2, 3])
    expect(rows.find((row) => row.title === 'Gemma 4B')?.fit).toBe('ok')
  })

  it('moves on to the next rung when the offer is already downloaded', async () => {
    mocks.recommended = [
      {
        rec: { modelName: 'unsloth/Qwen3.5-4B' },
        model: gguf('unsloth/Qwen3.5-4B', 2.5),
      },
      {
        rec: { modelName: 'unsloth/Qwen3.5-2B' },
        model: gguf('unsloth/Qwen3.5-2B', 1.2),
      },
    ]
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [{ id: 'Qwen3.5-4B-Q4_K_M', name: 'Qwen3.5 4B' }],
        },
      ],
    } as never)
    const { result } = renderHook(() => useModelOptions())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.recommended[0].catalog.model_name).toBe(
      'unsloth/Qwen3.5-2B'
    )
    expect(result.current.library).toEqual([
      expect.objectContaining({
        kind: 'library',
        provider: 'llamacpp-upstream',
        modelId: 'Qwen3.5-4B-Q4_K_M',
      }),
    ])
  })

  it('lists models other apps left on disk that can run', async () => {
    mocks.scan.mockResolvedValue([
      {
        id: 'llama.gguf',
        displayName: 'Llama-3.1-8B',
        path: '/lm/llama.gguf',
        format: 'gguf',
        source: 'lmstudio',
        runnable: true,
      },
      {
        id: 'adapter.gguf',
        displayName: 'adapter',
        path: '/lm/adapter.gguf',
        format: 'gguf',
        source: 'lmstudio',
        runnable: false,
      },
    ])
    const { result } = renderHook(() => useModelOptions())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.onDevice).toEqual([
      expect.objectContaining({
        kind: 'scan',
        provider: 'llamacpp-upstream',
        matchIds: ['llama.gguf'],
      }),
    ])
  })

  it('describes the machine for the device card', async () => {
    const { result } = renderHook(() => useModelOptions())
    await waitFor(() => expect(result.current.device.freeGb).toBe(84))

    expect(result.current.device).toEqual({
      name: 'Apple M2',
      memoryGb: 16,
      freeGb: 84,
    })
  })

  it('judges nothing it cannot measure', async () => {
    mocks.profile = null
    const { result } = renderHook(() => useModelOptions())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.recommended[0].fit).toBeNull()
    expect(result.current.device.memoryGb).toBeNull()
  })
})

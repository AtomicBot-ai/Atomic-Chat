/**
 * What the old first-run screen's suite proved about the list it offered that
 * the model step's options still have to: a fresh catalog, a scan that
 * honours the user's settings, plain names, one offer, and picks dealt by fit
 * and publisher.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { HardwareProfile } from '@/lib/hardware-tier'
import type { CatalogModel } from '@/services/models/types'

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  fetchSources: vi.fn(async () => {}),
  refreshRegistry: vi.fn(async () => {}),
  refreshPicks: vi.fn(async () => {}),
  recommended: [] as { rec: Record<string, unknown>; model: unknown }[],
  picks: [] as { pick: Record<string, unknown>; model: unknown }[],
  profile: null as unknown,
}))

vi.mock('@/services/models/localScan', () => ({
  scanLocalModels: mocks.scan,
  collectImportedModelPaths: () => ['/models/already-imported.gguf'],
}))
vi.mock('@/services/models/downloadPreflight', () => ({
  getDownloadFreeSpace: async () => null,
}))
vi.mock('@/hooks/useResolvedRecommendedModels', () => ({
  useResolvedRecommendedModels: () => mocks.recommended,
}))
vi.mock('@/hooks/useStaffPicks', () => ({
  useStaffPicks: () => mocks.picks,
}))
vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => ({
    tier: 'vram_8',
    profile: mocks.profile,
    ready: true,
  }),
}))
vi.mock('@/hooks/useModelSources', () => ({
  useModelSources: (select: (state: unknown) => unknown) =>
    select({ sources: [], fetchSources: mocks.fetchSources, loading: false }),
}))
vi.mock('@/stores/recommended-models-registry-store', () => ({
  useRecommendedModelsRegistryStore: {
    getState: () => ({ refresh: mocks.refreshRegistry }),
  },
}))
vi.mock('@/stores/staff-picks-store', () => ({
  useStaffPicksStore: { getState: () => ({ refresh: mocks.refreshPicks }) },
}))

import { useModelOptions } from '../useModelOptions'

const gguf = (repo: string, sizeGb: number): CatalogModel =>
  ({
    model_name: repo,
    developer: repo.split('/')[0],
    description: '',
    downloads: 0,
    quants: [
      {
        model_id: `${repo.split('/')[1]}-Q4_K_M`,
        path: `https://huggingface.co/${repo}/q4.gguf`,
        file_size: `${sizeGb} GB`,
      },
    ],
  }) as CatalogModel

const rung = (repo: string, sizeGb: number) => ({
  rec: { modelName: repo },
  model: gguf(repo, sizeGb),
})
const pick = (repo: string, sizeGb: number, title?: string) => ({
  pick: { model_name: repo, title },
  model: gguf(repo, sizeGb),
})

/** An 8 GiB card: past it llama.cpp spills into system RAM and still runs. */
const card: HardwareProfile = {
  tier: 'vram_8',
  memoryKind: 'vram',
  budgetMib: 8 * 1024,
  systemRamMib: 32 * 1024,
  vramMib: 8 * 1024,
  hardCeiling: false,
}

async function options() {
  const hook = renderHook(() => useModelOptions())
  await waitFor(() => expect(hook.result.current.ready).toBe(true))
  return hook.result.current
}

describe('model step options, as the old setup screen proved them', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.scan.mockResolvedValue([])
    mocks.profile = card
    mocks.recommended = [rung('AtomicChat/Qwen3.5-4B-GGUF', 2.5)]
    mocks.picks = []
    useModelProvider.setState({ providers: [] } as never)
    useGeneralSetting.setState({ scanLocalModels: true, localScanFolders: [] })
  })

  it('asks for a fresh offer and fresh Hub picks, past the hour-long cache', async () => {
    // A cache written before the manifest changed is served without any
    // network call, so the step would offer models the manifest no longer
    // lists. The picks under the offer are the Hub's manifest: same rule.
    await options()

    expect(mocks.refreshRegistry.mock.calls).toEqual([[{ force: true }]])
    expect(mocks.refreshPicks.mock.calls).toEqual([[{ force: true }]])
    expect(mocks.fetchSources.mock.calls).toHaveLength(1)
  })

  it('scans with the user’s own settings, past what the library already holds', async () => {
    useGeneralSetting.setState({
      scanLocalModels: false,
      localScanFolders: ['/Volumes/models'],
    })

    await options()

    expect(mocks.scan.mock.calls).toEqual([
      [
        {
          enabled: false,
          extraRoots: ['/Volumes/models'],
          importedPaths: ['/models/already-imported.gguf'],
        },
      ],
    ])
  })

  it('names the offer in plain words, without the repository or the packaging', async () => {
    const { recommended } = await options()

    expect(recommended[0].title).toBe('Qwen3.5 4B')
  })

  it('offers one rung of the registry ladder, never the rest of it', async () => {
    // The other rungs are what the recommender steps down through when the
    // offer does not fit; shown as rows they were the comparison table the
    // single offer replaced.
    mocks.recommended = [
      rung('AtomicChat/Qwen3.5-4B-GGUF', 2.5),
      rung('AtomicChat/Qwen3.5-9B-GGUF', 5.2),
    ]

    const { recommended } = await options()

    expect(recommended.map((row) => row.catalog.model_name)).toEqual([
      'AtomicChat/Qwen3.5-4B-GGUF',
    ])
  })

  it('does not list the offer a second time when it is also a Hub pick', async () => {
    mocks.picks = [
      pick('AtomicChat/Qwen3.5-4B-GGUF', 2.5, 'Qwen3.5 4B'),
      pick('google/gemma-3-4b-it-GGUF', 3, 'Gemma 3 4B'),
    ]

    const { recommended } = await options()

    expect(recommended.map((row) => row.title)).toEqual([
      'Qwen3.5 4B',
      'Gemma 3 4B',
    ])
  })

  it('lists the picks on their own when the registry has no offer', async () => {
    mocks.recommended = []
    mocks.picks = [
      pick('google/gemma-3-4b-it-GGUF', 3, 'Gemma 3 4B'),
      pick('ibm-granite/granite-4.0-micro-GGUF', 2, 'Granite 4 Micro'),
    ]

    const { recommended } = await options()

    // Nothing is promoted, and positions start at 0: there is no offer to
    // leave room for.
    expect(
      recommended.map((row) => [row.title, row.bestFit, row.position])
    ).toEqual([
      ['Gemma 3 4B', false, 0],
      ['Granite 4 Micro', false, 1],
    ])
  })

  it('lists what fits first and keeps a pick that only runs slower on a card', async () => {
    // On Windows and Linux llama.cpp spills into system RAM: slower, but it
    // runs, so the pick stays — after the ones that fit.
    mocks.picks = [
      pick('mistralai/Mistral-Small-24B-GGUF', 14, 'Mistral Small'),
      pick('meta-llama/Llama-3.1-8B-GGUF', 6, 'Llama 3.1 8B'),
      pick('google/gemma-3-4b-it-GGUF', 3, 'Gemma 3 4B'),
    ]

    const { recommended } = await options()

    expect(recommended.map((row) => [row.title, row.fit])).toEqual([
      ['Qwen3.5 4B', 'ok'],
      ['Gemma 3 4B', 'ok'],
      ['Mistral Small', 'warn'],
    ])
  })

  it('deals the picks so two from one publisher never sit together, starting away from the offer', async () => {
    // The offer counts as the row above the list: it is Qwen here, so the
    // first pick may not be.
    mocks.picks = [
      pick('unsloth/Qwen3.5-2B-GGUF', 1.5, 'Qwen3.5 2B'),
      pick('unsloth/Qwen3.5-0.8B-GGUF', 0.6, 'Qwen3.5 0.8B'),
      pick('google/gemma-3-4b-it-GGUF', 3, 'Gemma 3 4B'),
    ]

    const { recommended } = await options()

    expect(recommended.map((row) => row.title)).toEqual([
      'Qwen3.5 4B',
      'Gemma 3 4B',
      'Qwen3.5 2B',
    ])
  })

  it('judges a CPU-only machine by its memory', async () => {
    mocks.profile = {
      tier: 'cpu_only',
      memoryKind: 'system',
      budgetMib: 32 * 1024,
      systemRamMib: 32 * 1024,
      vramMib: 0,
      hardCeiling: false,
    }

    const { recommended } = await options()

    expect(recommended[0].fit).toBe('ok')
  })

  it('leaves out a pick whose catalog card has not resolved', async () => {
    // The old screen held a disabled row for it; the step offers only what
    // it can start the moment the user presses Continue.
    mocks.picks = [
      { pick: { model_name: 'unsloth/DeepSeek-V4-Flash-GGUF' }, model: null },
      pick('google/gemma-3-4b-it-GGUF', 3, 'Gemma 3 4B'),
    ]

    const { recommended } = await options()

    expect(recommended.map((row) => row.title)).toEqual([
      'Qwen3.5 4B',
      'Gemma 3 4B',
    ])
  })
})

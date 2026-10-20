import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EMBEDDING_MODEL_ID } from '@/constants/models'
import {
  VOICE_MODEL_BYTES,
  VOICE_MODEL_ID,
  VOICE_MODEL_NAME,
} from '@/constants/voice'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import {
  InventoryNotRemovableError,
  removeInventoryItem,
  useInstalledInventory,
} from '@/hooks/useInstalledInventory'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  makeCatalog,
  makeFilesFor,
  Q4_ID,
  Q8_ID,
  Z_IMAGE,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { LTX_2, LTX_Q4_ID } from '@/lib/diffusion/__tests__/video-fixtures'
import {
  diffusionDownloadTaskId,
  listInstalledArtifacts,
} from '@/lib/diffusion/models'
import { decisionDownloadTaskId } from '@/lib/decision/models'
import { embeddingDownloadTaskId } from '@/lib/embedding/models'
import type { InventoryItem } from '@/lib/installed-inventory'
import type { ServiceHub } from '@/services'
import { getBaselineDecisionCatalog } from '@/services/decision-catalog-registry'
import {
  embeddingDiskBytes,
  getBaselineEmbeddingCatalog,
} from '@/services/embedding-catalog-registry'
import type { EngineVersions } from '@/services/engines/types'
import { useDecisionStore } from '@/stores/decision-store'
import { useEmbeddingStore } from '@/stores/embedding-store'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

// Importing the registry store fires a background fetch that lands mid-test.
vi.mock('@/stores/provider-registry-store', () => ({
  useProviderRegistryStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = { providers: [], hasInitialized: true, refresh: vi.fn() }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({
        providers: [],
        hasInitialized: true,
        refresh: vi.fn(),
      }),
    }
  ),
  isKnownProvider: () => true,
  ensureRegistryLoaded: async () => [],
}))

const deleteLocalModel = vi.hoisted(() => vi.fn())
vi.mock('@/lib/model-deletion', () => ({ deleteLocalModel }))

const deleteEngineBuild = vi.hoisted(() => vi.fn())
vi.mock('@/services/engines/core', () => ({
  deleteEngineBuild,
  engineVersions: vi.fn(),
}))

const deleteEmbeddingModel = vi.hoisted(() => vi.fn())
vi.mock('@/lib/embedding/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/embedding/models')>()),
  deleteEmbeddingModel,
}))

const deleteDecisionModel = vi.hoisted(() => vi.fn())
vi.mock('@/lib/decision/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decision/models')>()),
  deleteDecisionModel,
}))

const releaseVoiceEngine = vi.hoisted(() => vi.fn())
vi.mock('@/lib/voice/engine', () => ({ releaseVoiceEngine }))

const GB = 1024 ** 3

const provider = (name: string, models: Partial<Model>[]): ModelProvider =>
  ({
    active: true,
    provider: name,
    persist: true,
    settings: [],
    models: models.map((model) => ({ id: 'unset', ...model })),
  }) as ModelProvider

const engineVersions = (
  engine: EngineVersions['engine'],
  builds: EngineVersions['builds']
): EngineVersions => ({
  engine,
  kind: 'llamacpp',
  active_choice: 'client',
  builds,
  active: null,
  latest: null,
  update: { needed: false, target: null, apply: 'swap' },
  source: null,
  source_error: null,
  error: null,
})

const inventory = () => renderHook(() => useInstalledInventory()).result

const byKey = (items: InventoryItem[], key: string) =>
  items.find((item) => item.key === key)

let serviceHub: ServiceHub

beforeEach(() => {
  vi.clearAllMocks()
  serviceHub = seedServiceHub({
    decision: { isSupported: () => false } as never,
  })
  useModelProvider.setState({ providers: [], deletedModels: [] })
  useImageGenerationStore.setState({
    catalog: null,
    installedArtifacts: [],
    modelFiles: [],
  })
  useEmbeddingStore.setState({
    catalog: getBaselineEmbeddingCatalog(),
    installed: {},
    config: null,
    bind: () => () => {},
    refresh: vi.fn().mockResolvedValue(undefined),
    refreshInstalled: vi.fn().mockResolvedValue(undefined),
  })
  useDecisionStore.setState({
    catalog: getBaselineDecisionCatalog(),
    installed: {},
    config: null,
    bind: () => () => {},
    refresh: vi.fn().mockResolvedValue(undefined),
    refreshInstalled: vi.fn().mockResolvedValue(undefined),
  })
  useEngineVersionsStore.setState({
    engines: {},
    refresh: vi.fn().mockResolvedValue(undefined),
  })
  useDownloadStore.setState({
    downloads: {},
    localDownloadingModels: new Set(),
    pausedDownloads: new Set(),
    downloadOriginByModelId: {},
  })
})

describe('useInstalledInventory', () => {
  it('lists each local model file once, under the provider that owns it', () => {
    useModelProvider.setState({
      providers: [
        provider('llamacpp-upstream', [
          { id: 'unsloth/Qwen3.5-4B-Q4_K_M', sizeBytes: 2.6 * GB },
          { id: 'nomic-embed', embedding: true, sizeBytes: 0.3 * GB },
          { id: EMBEDDING_MODEL_ID, sizeBytes: 0.1 * GB },
          { id: 'imported-without-size', sizeBytes: 0 },
        ]),
        // The fork reads the same models directory.
        provider('llamacpp', [
          { id: 'unsloth/Qwen3.5-4B-Q4_K_M', sizeBytes: 2.6 * GB },
        ]),
        provider('mlx', [{ id: 'Qwen3.5-4B-4bit', sizeBytes: 2.4 * GB }]),
        // Every managed engine lists the shared store.
        provider('vllm', [{ id: 'Qwen/Qwen3-8B', sizeBytes: 16 * GB }]),
        provider('sglang', [{ id: 'Qwen/Qwen3-8B', sizeBytes: 16 * GB }]),
        provider('foundry-local', [
          { id: 'phi-4-mini-cpu', name: 'Phi-4 mini', sizeBytes: 3 * GB },
        ]),
        // A cloud provider's models are not on this computer.
        provider('openai', [{ id: 'gpt-5' }]),
      ],
    })

    const { items, totalBytes } = inventory().current

    expect(items.map((item) => item.key)).toEqual([
      'model:local:imported-without-size',
      'model:local:nomic-embed',
      'model:foundry:phi-4-mini-cpu',
      'model:managed:Qwen/Qwen3-8B',
      'model:local:Qwen3.5-4B-4bit',
      'model:local:unsloth/Qwen3.5-4B-Q4_K_M',
    ])
    expect(byKey(items, 'model:local:unsloth/Qwen3.5-4B-Q4_K_M')).toMatchObject(
      {
        category: 'local',
        kind: 'model',
        details: ['llama.cpp'],
        bytes: 2.6 * GB,
        removal: {
          type: 'model',
          modelId: 'unsloth/Qwen3.5-4B-Q4_K_M',
          provider: 'llamacpp-upstream',
        },
      }
    )
    expect(byKey(items, 'model:local:nomic-embed')?.kind).toBe('embedding')
    expect(byKey(items, 'model:foundry:phi-4-mini-cpu')?.name).toBe(
      'Phi-4 mini'
    )
    expect(byKey(items, 'model:managed:Qwen/Qwen3-8B')?.removal).toEqual({
      type: 'model',
      modelId: 'Qwen/Qwen3-8B',
      provider: 'vllm',
    })
    // A size the engine did not record is unknown, not zero.
    expect(byKey(items, 'model:local:imported-without-size')?.bytes).toBeNull()
    expect(totalBytes).toBe((2.6 + 0.3 + 2.4 + 16 + 3) * GB)
  })

  it('counts an encoder two checkpoints share once', () => {
    const catalog = makeCatalog([Z_IMAGE, LTX_2])
    const modelFiles = [
      ...makeFilesFor(Z_IMAGE, 'q4_k_m'),
      ...makeFilesFor(Z_IMAGE, 'q8_0'),
      ...makeFilesFor(LTX_2, 'q4_k_m'),
    ]
    useImageGenerationStore.setState({
      catalog,
      modelFiles,
      installedArtifacts: listInstalledArtifacts(catalog, modelFiles),
    })

    const { items, totalBytes } = inventory().current

    const q4 = byKey(items, `artifact:${Q4_ID}`)
    const q8 = byKey(items, `artifact:${Q8_ID}`)
    expect(q4).toMatchObject({
      category: 'image',
      kind: 'image',
      name: 'Z-Image Turbo',
      details: ['Q4_K_M'],
      bytes: 4_000_000_000 + 300_000_000 + 2_500_000_000,
      removal: { type: 'artifact', artifactId: Q4_ID },
    })
    expect(q8?.bytes).toBe(8_000_000_000 + 300_000_000 + 2_500_000_000)
    expect(byKey(items, `artifact:${LTX_Q4_ID}`)).toMatchObject({
      category: 'video',
      kind: 'video',
    })
    const unique = new Map(
      modelFiles.map((file) => [file.relativePath, file.bytes])
    )
    expect(totalBytes).toBe(
      [...unique.values()].reduce((sum, bytes) => sum + bytes, 0)
    )
  })

  it('lists installed embedding and decision models with their catalog sizes', () => {
    const embedding = getBaselineEmbeddingCatalog().models[0]
    const decision = getBaselineDecisionCatalog().models[0]
    useEmbeddingStore.setState({ installed: { [embedding.id]: true } })
    useDecisionStore.setState({ installed: { [decision.id]: true } })

    const { items } = inventory().current

    expect(byKey(items, `embedding:${embedding.id}`)).toMatchObject({
      category: 'local',
      kind: 'embedding',
      name: embedding.name,
      bytes: embeddingDiskBytes(embedding),
      removal: { type: 'embedding', model: embedding },
    })
    expect(byKey(items, `decision:${decision.id}`)).toMatchObject({
      category: 'local',
      kind: 'decision',
      name: decision.name,
      removal: { type: 'decision', model: decision },
    })
    expect(
      items.filter(
        (item) => item.kind === 'embedding' || item.kind === 'decision'
      )
    ).toHaveLength(2)
  })

  it('shows the voice model once, in Voice, not as a llama.cpp model', () => {
    useModelProvider.setState({
      providers: [
        provider('llamacpp-upstream', [
          { id: VOICE_MODEL_ID, sizeBytes: 3 * GB },
        ]),
      ],
    })

    const { items } = inventory().current

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      key: `voice:${VOICE_MODEL_ID}`,
      category: 'voice',
      name: VOICE_MODEL_NAME,
      bytes: 3 * GB,
      removal: { type: 'voice' },
    })
  })

  it('falls back to the catalog size of the voice model', () => {
    useModelProvider.setState({
      providers: [provider('llamacpp-upstream', [{ id: VOICE_MODEL_ID }])],
    })

    expect(inventory().current.items[0].bytes).toBe(VOICE_MODEL_BYTES)
  })

  it('lists engine builds without a size and keeps the core’s refusal', () => {
    useEngineVersionsStore.setState({
      engines: {
        'llamacpp-upstream': engineVersions('llamacpp-upstream', [
          {
            version: 'b6500',
            variant: 'macos-arm64',
            origin: 'downloaded',
            active: true,
            in_use: false,
            removable: false,
            not_removable_reason: 'active',
          },
          {
            version: 'b6400',
            variant: 'macos-arm64',
            origin: 'downloaded',
            active: false,
            in_use: false,
            removable: true,
          },
        ]),
      },
    })

    const { items, totalBytes } = inventory().current

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.bytes === null)).toBe(true)
    expect(items.every((item) => item.category === 'engine')).toBe(true)
    expect(
      byKey(items, 'engine:llamacpp-upstream:b6500:macos-arm64')
    ).toMatchObject({
      name: 'llama.cpp',
      details: ['b6500', 'macos-arm64'],
      notRemovableReason: 'active',
    })
    expect(
      byKey(items, 'engine:llamacpp-upstream:b6400:macos-arm64')
        ?.notRemovableReason
    ).toBeUndefined()
    expect(totalBytes).toBe(0)
  })

  it('puts running downloads first, under the category they land in', () => {
    const embedding = getBaselineEmbeddingCatalog().models[0]
    const decision = getBaselineDecisionCatalog().models[0]
    const catalog = makeCatalog([Z_IMAGE, LTX_2])
    useImageGenerationStore.setState({ catalog })
    useModelProvider.setState({
      providers: [
        provider('llamacpp-upstream', [{ id: 'installed', sizeBytes: GB }]),
      ],
    })
    const progress = (id: string, current: number, total: number) => ({
      id,
      name: id,
      progress: total ? current / total : 0,
      current,
      total,
      speed: { bytesPerSecond: 0, atBytes: 0, atTime: 0 },
    })
    const videoTask = diffusionDownloadTaskId(LTX_Q4_ID)
    useDownloadStore.setState({
      downloads: {
        [videoTask]: progress(videoTask, GB, 4 * GB),
        [embeddingDownloadTaskId(embedding.id)]: progress(
          embeddingDownloadTaskId(embedding.id),
          1,
          2
        ),
        'unsloth/Big-Model-Q4_K_M': progress(
          'unsloth/Big-Model-Q4_K_M',
          2 * GB,
          20 * GB
        ),
      },
      localDownloadingModels: new Set([
        decisionDownloadTaskId(decision.id),
        VOICE_MODEL_ID,
      ]),
      pausedDownloads: new Set(['unsloth/Big-Model-Q4_K_M']),
    })

    const { items, totalBytes } = inventory().current

    const downloads = items.filter((item) => item.download)
    expect(items.slice(0, downloads.length)).toEqual(downloads)
    expect(
      Object.fromEntries(downloads.map((item) => [item.name, item.category]))
    ).toEqual({
      [decision.name]: 'local',
      [embedding.name]: 'local',
      'unsloth/Big-Model-Q4_K_M': 'local',
      [LTX_2.name]: 'video',
      [VOICE_MODEL_NAME]: 'voice',
    })
    expect(downloads).toHaveLength(5)
    expect(
      downloads.find((item) => item.name === 'unsloth/Big-Model-Q4_K_M')
        ?.download
    ).toMatchObject({ current: 2 * GB, total: 20 * GB, paused: true })
    expect(downloads.every((item) => item.removal === null)).toBe(true)
    // What is still downloading is not on disk yet.
    expect(totalBytes).toBe(GB)
  })
})

describe('removeInventoryItem', () => {
  const removeVoice = vi.fn()
  const remove = (item: InventoryItem) =>
    removeInventoryItem(item, { serviceHub, removeVoice })
  const item = (overrides: Partial<InventoryItem>): InventoryItem => ({
    key: 'k',
    category: 'local',
    kind: 'model',
    name: 'Item',
    details: [],
    bytes: null,
    removal: null,
    ...overrides,
  })

  it('deletes a model file through the provider registry', async () => {
    await expect(
      remove(
        item({
          removal: { type: 'model', modelId: 'm', provider: 'llamacpp' },
        })
      )
    ).resolves.toBeUndefined()
    expect(deleteLocalModel).toHaveBeenCalledWith(serviceHub, 'm', 'llamacpp')
  })

  it('removes a checkpoint through the image-generation store', async () => {
    const removeArtifact = vi.fn().mockResolvedValue(undefined)
    useImageGenerationStore.setState({ removeArtifact })
    await expect(
      remove(item({ removal: { type: 'artifact', artifactId: Q4_ID } }))
    ).resolves.toBeUndefined()
    expect(removeArtifact).toHaveBeenCalledWith(Q4_ID)
  })

  it('removes an embedding model and re-reads what is installed', async () => {
    const model = getBaselineEmbeddingCatalog().models[0]
    const config = { model_path: 'x' } as never
    useEmbeddingStore.setState({ config })
    const resumable = embeddingDownloadTaskId(model.id)
    useDownloadStore.setState({ resumableDownloads: new Set([resumable]) })

    await remove(item({ removal: { type: 'embedding', model } }))

    expect(deleteEmbeddingModel).toHaveBeenCalledWith(model, config)
    expect(useEmbeddingStore.getState().refreshInstalled).toHaveBeenCalled()
    expect(useDownloadStore.getState().resumableDownloads.has(resumable)).toBe(
      false
    )
  })

  it('removes a decision model and re-reads what is installed', async () => {
    const model = getBaselineDecisionCatalog().models[0]
    const resumable = decisionDownloadTaskId(model.id)
    useDownloadStore.setState({ resumableDownloads: new Set([resumable]) })

    await expect(
      remove(item({ removal: { type: 'decision', model } }))
    ).resolves.toBeUndefined()

    expect(deleteDecisionModel).toHaveBeenCalledWith(model, null)
    expect(useDecisionStore.getState().refreshInstalled).toHaveBeenCalled()
    // A half-finished download of it can no longer be resumed.
    expect(useDownloadStore.getState().resumableDownloads.has(resumable)).toBe(
      false
    )
  })

  it('removes the voice model through its hook', async () => {
    await expect(
      remove(item({ removal: { type: 'voice' } }))
    ).resolves.toBeUndefined()
    expect(removeVoice).toHaveBeenCalled()
  })

  it('removes an engine build through the core and re-reads the builds', async () => {
    await expect(
      remove(
        item({
          removal: {
            type: 'engine-build',
            engine: 'mlx',
            version: 'v1',
            variant: 'macos-arm64',
          },
        })
      )
    ).resolves.toBeUndefined()
    expect(deleteEngineBuild).toHaveBeenCalledWith('mlx', 'v1', 'macos-arm64')
    expect(useEngineVersionsStore.getState().refresh).toHaveBeenCalled()
  })

  it('re-reads the builds when the core refuses, and passes the refusal on', async () => {
    const refusal = { code: 'BACKEND_IN_USE', message: 'busy' }
    deleteEngineBuild.mockRejectedValueOnce(refusal)
    await expect(
      remove(
        item({
          removal: {
            type: 'engine-build',
            engine: 'mlx',
            version: 'v1',
            variant: 'macos-arm64',
          },
        })
      )
    ).rejects.toBe(refusal)
    expect(useEngineVersionsStore.getState().refresh).toHaveBeenCalled()
  })

  it('never asks the core to remove a build it refuses to remove', async () => {
    await expect(
      remove(
        item({
          notRemovableReason: 'bundled',
          removal: {
            type: 'engine-build',
            engine: 'llamacpp',
            version: 'b1',
            variant: 'macos-arm64',
          },
        })
      )
    ).rejects.toBeInstanceOf(InventoryNotRemovableError)
    expect(deleteEngineBuild).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

const mocks = vi.hoisted(() => ({
  engines: {} as Record<string, { import: ReturnType<typeof vi.fn> }>,
  markSilentImport: vi.fn(),
}))

vi.mock('@janhq/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  EngineManager: {
    instance: () => ({ get: (name: string) => mocks.engines[name] }),
  },
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/utils/backgroundImports', () => ({
  markSilentImport: mocks.markSilentImport,
}))

import { useDownloadStore } from '@/hooks/useDownloadStore'
import type { ServiceHub } from '@/services'
import type { LocalModelCandidate } from '@/services/models/localScan'
import type { CatalogModel } from '@/services/models/types'

import {
  importCandidatesInBackground,
  mlxModelId,
  providerForCandidate,
  startMlxCatalogDownload,
} from '../downloads'

const catalog = {
  model_name: 'mlx-community/Qwen3.5 4B 4bit',
  developer: 'mlx-community',
} as CatalogModel

const repo = {
  siblings: [
    { rfilename: 'config.json' },
    { rfilename: 'model.safetensors' },
    { rfilename: 'tokenizer.json' },
  ],
}

const hubWith = (fetchHuggingFaceRepo: () => Promise<unknown>) =>
  ({
    models: () => ({ fetchHuggingFaceRepo }),
  }) as unknown as ServiceHub

const candidate = (
  id: string,
  format: 'gguf' | 'mlx',
  runnable = true
): LocalModelCandidate =>
  ({
    id,
    displayName: id,
    path: `/models/${id}`,
    format,
    source: 'lmstudio',
    runnable,
  }) as LocalModelCandidate

describe('MLX downloads from setup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.engines = { mlx: { import: vi.fn().mockResolvedValue(undefined) } }
    useDownloadStore.setState({
      localDownloadingModels: new Set(),
      resumableDownloads: new Set(),
      downloadOriginByModelId: {},
      downloadRequestOriginByModelId: {},
    })
  })

  it('names the model the way the MLX engine registers it', () => {
    expect(mlxModelId(catalog)).toBe('Qwen3.5-4B-4bit')
  })

  it('downloads the safetensors file with the rest of the repository beside it', async () => {
    const started = await startMlxCatalogDownload(catalog, {
      serviceHub: hubWith(async () => repo),
      requestOrigin: 'onboarding',
    })

    expect(started).toBe(true)
    const base =
      'https://huggingface.co/mlx-community/Qwen3.5 4B 4bit/resolve/main'
    expect(mocks.engines.mlx.import).toHaveBeenCalledWith('Qwen3.5-4B-4bit', {
      modelPath: `${base}/model.safetensors`,
      files: [
        { url: `${base}/config.json`, filename: 'config.json' },
        { url: `${base}/tokenizer.json`, filename: 'tokenizer.json' },
      ],
      resume: false,
    })
    const state = useDownloadStore.getState()
    expect(state.localDownloadingModels.has('Qwen3.5-4B-4bit')).toBe(true)
    expect(state.downloadRequestOriginByModelId['Qwen3.5-4B-4bit']).toBe(
      'onboarding'
    )
  })

  it('resumes a download that was paused before', async () => {
    useDownloadStore.setState({
      resumableDownloads: new Set(['Qwen3.5-4B-4bit']),
    })

    await startMlxCatalogDownload(catalog, {
      serviceHub: hubWith(async () => repo),
    })

    expect(mocks.engines.mlx.import.mock.calls[0][1].resume).toBe(true)
  })

  it('reports a repository without weights and leaves it resumable', async () => {
    const started = await startMlxCatalogDownload(catalog, {
      serviceHub: hubWith(async () => ({
        siblings: [{ rfilename: 'a.json' }],
      })),
    })

    expect(started).toBe(false)
    expect(toast.error).toHaveBeenCalledWith('Failed to download MLX model', {
      description: 'No safetensors file found in repository',
    })
    const state = useDownloadStore.getState()
    expect(state.localDownloadingModels.has('Qwen3.5-4B-4bit')).toBe(false)
    expect(state.resumableDownloads.has('Qwen3.5-4B-4bit')).toBe(true)
  })

  it('stays quiet when the download was cancelled', async () => {
    mocks.engines.mlx.import.mockRejectedValue(new Error('Download cancelled'))

    const started = await startMlxCatalogDownload(catalog, {
      serviceHub: hubWith(async () => repo),
    })

    expect(started).toBe(false)
    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe('importing models found on disk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.engines = {
      'mlx': { import: vi.fn().mockResolvedValue(undefined) },
      'llamacpp-upstream': { import: vi.fn().mockResolvedValue(undefined) },
    }
  })

  it('imports a GGUF into llama.cpp and an MLX folder into MLX', () => {
    expect(providerForCandidate({ format: 'gguf' })).toBe('llamacpp-upstream')
    expect(providerForCandidate({ format: 'mlx' })).toBe('mlx')
  })

  it('adds every runnable model silently, then hands back the library', async () => {
    const refreshed = [
      { provider: 'mlx', models: [] },
    ] as unknown as ModelProvider[]
    const getProviders = vi.fn().mockResolvedValue(refreshed)
    const onProviders = vi.fn()

    importCandidatesInBackground(
      [
        candidate('qwen.gguf', 'gguf'),
        candidate('Llama-3-8B-4bit', 'mlx'),
        candidate('broken.gguf', 'gguf', false),
      ],
      {
        serviceHub: {
          providers: () => ({ getProviders }),
        } as unknown as ServiceHub,
        onProviders,
      }
    )

    await vi.waitFor(() => expect(onProviders).toHaveBeenCalledWith(refreshed))
    expect(mocks.markSilentImport.mock.calls.map(([id]) => id)).toEqual([
      'qwen.gguf',
      'Llama-3-8B-4bit',
    ])
    expect(mocks.engines['llamacpp-upstream'].import).toHaveBeenCalledWith(
      'qwen.gguf',
      {
        modelPath: '/models/qwen.gguf',
        mmprojPath: undefined,
        source: 'lmstudio',
      }
    )
    expect(mocks.engines.mlx.import).toHaveBeenCalledTimes(1)
  })
})

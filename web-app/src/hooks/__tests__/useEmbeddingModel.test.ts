import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const lib = vi.hoisted(() => ({
  activateEmbeddingModel: vi.fn(),
  activateLocalEmbeddingModel: vi.fn(),
  stopEmbeddingModel: vi.fn(),
  deleteEmbeddingModel: vi.fn(),
  downloadEmbeddingModel: vi.fn(),
  isEmbeddingModelInstalled: vi.fn(),
  readLocalEmbeddingModel: vi.fn(),
}))

vi.mock('@/lib/embedding/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/embedding/models')>()),
  ...lib,
}))

const cancelTransfer = vi.hoisted(() => vi.fn())
vi.mock('@/services/diffusion/transfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/diffusion/transfer')>()),
  cancelTransfer,
}))

const raiseServer = vi.hoisted(() => vi.fn())
vi.mock('@/utils/localApiServerControl', () => ({
  raiseLocalApiServerForMediaModel: raiseServer,
}))

import { useDownloadStore } from '@/hooks/useDownloadStore'
import {
  useEmbeddingModel,
  useLocalEmbeddingModel,
  useLocalEmbeddingModels,
} from '@/hooks/useEmbeddingModel'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { LocalEmbeddingModel } from '@/lib/embedding/models'
import type { EmbeddingCatalogModel } from '@/services/embedding-catalog-registry'
import type {
  EmbeddingConfig,
  EmbeddingService,
} from '@/services/embedding/types'
import { useEmbeddingStore } from '@/stores/embedding-store'
import { seedServiceHub } from '@/test/service-hub'

const model: EmbeddingCatalogModel = {
  id: 'bge-m3',
  name: 'BGE-M3',
  description: 'BAAI multilingual embedding model.',
  repo: 'ggml-org/bge-m3-Q8_0-GGUF',
  revision: 'b'.repeat(40),
  params: '568M',
  languages: 'multilingual',
  context: 8192,
  max_context: 8192,
  dims: 1024,
  pooling: 'cls',
  modalities: ['text'],
  license: 'mit',
  min_engine: 'b11443',
  engine: 'llamacpp-upstream',
  format: 'gguf',
  icon: 'baai',
  files: [
    {
      path: 'bge-m3-q8_0.gguf',
      role: 'model',
      bytes: 600,
      sha256: 'a'.repeat(64),
    },
  ],
}
const MODEL_PATH = 'embedding/models/bge-m3/bge-m3-q8_0.gguf'

const local: LocalEmbeddingModel = {
  id: 'bge-m3',
  name: 'bge-m3 (llama.cpp)',
  model_path: 'llamacpp/models/bge-m3/model.gguf',
  mmproj_path: '',
}

const getConfig = vi.fn()

const initialEmbedding = useEmbeddingStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useEmbeddingStore.setState(initialEmbedding, true)
  useDownloadStore.setState({
    downloads: {},
    localDownloadingModels: new Set(),
    resumableDownloads: new Set(),
  })
  lib.activateEmbeddingModel.mockResolvedValue({ state: 'ready' })
  lib.activateLocalEmbeddingModel.mockResolvedValue({ state: 'ready' })
  lib.stopEmbeddingModel.mockResolvedValue(undefined)
  lib.deleteEmbeddingModel.mockResolvedValue(undefined)
  lib.downloadEmbeddingModel.mockResolvedValue(undefined)
  lib.isEmbeddingModelInstalled.mockResolvedValue(true)
  getConfig.mockResolvedValue({
    config: { model_path: MODEL_PATH },
    status: { state: 'ready' },
  })
  seedServiceHub({
    embedding: {
      isSupported: () => true,
      getConfig,
    } as unknown as EmbeddingService,
  })
})

// Unmount before the shared teardown drops the service hub the hook reads.
afterEach(() => {
  cleanup()
  useModelProvider.setState({ providers: [] as never })
})

describe('useEmbeddingModel', () => {
  it('reports the state only for the running model', () => {
    useEmbeddingStore.setState({
      config: { enabled: true, model_path: MODEL_PATH } as EmbeddingConfig,
      status: { state: 'starting' } as never,
    })
    const { result } = renderHook(() => useEmbeddingModel(model))
    expect(result.current.active).toBe(true)
    expect(result.current.running).toBe(true)
    expect(result.current.state).toBe('starting')

    const other = renderHook(() => useEmbeddingModel({ ...model, id: 'other' }))
    expect(other.result.current.active).toBe(false)
    expect(other.result.current.state).toBeNull()
  })

  it('is not running once stopped, though still the configured model', () => {
    useEmbeddingStore.setState({
      config: { enabled: false, model_path: MODEL_PATH } as EmbeddingConfig,
      status: { state: 'disabled' } as never,
    })
    const { result } = renderHook(() => useEmbeddingModel(model))
    expect(result.current.active).toBe(true)
    expect(result.current.running).toBe(false)
    expect(result.current.state).toBeNull()
  })

  it('reads progress from the download panel row', () => {
    useDownloadStore.setState({
      downloads: {
        'embedding-bge-m3': {
          id: 'embedding-bge-m3',
          name: 'embedding-bge-m3',
          progress: 0.5,
          current: 300,
          total: 600,
        } as never,
      },
    })
    const { result } = renderHook(() => useEmbeddingModel(model))
    expect(result.current.downloading).toBe(true)
    expect(result.current.progress).toBe(0.5)
    expect(result.current.totalBytes).toBe(600)
  })

  it('resumes a cancelled download and re-checks the disk afterwards', async () => {
    useDownloadStore.setState({
      resumableDownloads: new Set(['embedding-bge-m3']),
    })
    const { result } = renderHook(() => useEmbeddingModel(model))
    await act(async () => {
      await result.current.download()
    })
    expect(lib.downloadEmbeddingModel).toHaveBeenCalledWith(model, {
      resume: true,
    })
    expect(useEmbeddingStore.getState().installed['bge-m3']).toBe(true)
    expect(useDownloadStore.getState().localDownloadingModels.size).toBe(0)
  })

  it('keeps a failed download resumable', async () => {
    lib.downloadEmbeddingModel.mockRejectedValue(new Error('HTTP status 500'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useEmbeddingModel(model))
    await act(async () => {
      await result.current.download()
    })
    expect(
      useDownloadStore.getState().resumableDownloads.has('embedding-bge-m3')
    ).toBe(true)
  })

  it('cancels the transfer and keeps the download resumable', () => {
    const { result } = renderHook(() => useEmbeddingModel(model))
    result.current.cancelDownload()
    expect(cancelTransfer).toHaveBeenCalledWith('embedding-bge-m3')
    expect(
      useDownloadStore.getState().resumableDownloads.has('embedding-bge-m3')
    ).toBe(true)
  })

  it('raises the Local API Server once the model is up', async () => {
    const { result } = renderHook(() => useEmbeddingModel(model))
    await act(async () => {
      await result.current.activate()
    })
    expect(lib.activateEmbeddingModel).toHaveBeenCalledWith(model)
    expect(raiseServer).toHaveBeenCalledOnce()
    expect(useEmbeddingStore.getState().error).toBeNull()
    expect(useEmbeddingStore.getState().busy).toBeNull()
  })

  it('keeps the core error when the model does not start', async () => {
    lib.activateEmbeddingModel.mockRejectedValue({
      code: 'EMBEDDING_ENGINE_UNSUPPORTED',
      message: 'Update llama.cpp to b11454 or newer.',
    })
    const { result } = renderHook(() => useEmbeddingModel(model))
    await act(async () => {
      await result.current.activate()
    })
    expect(raiseServer).not.toHaveBeenCalled()
    expect(useEmbeddingStore.getState().error?.code).toBe(
      'EMBEDDING_ENGINE_UNSUPPORTED'
    )
  })

  it('removes with the current config and refreshes the install state', async () => {
    const config = { model_path: MODEL_PATH } as EmbeddingConfig
    useEmbeddingStore.setState({ config, installed: { 'bge-m3': true } })
    lib.isEmbeddingModelInstalled.mockResolvedValue(false)
    const { result } = renderHook(() => useEmbeddingModel(model))
    await act(async () => {
      await result.current.remove()
    })
    expect(lib.deleteEmbeddingModel).toHaveBeenCalledWith(model, config)
    expect(result.current.installed).toBe(false)
  })

  it('stops the model', async () => {
    const { result } = renderHook(() => useEmbeddingModel(model))
    await act(async () => {
      await result.current.stop()
    })
    expect(lib.stopEmbeddingModel).toHaveBeenCalledOnce()
    expect(useEmbeddingStore.getState().config?.model_path).toBe(MODEL_PATH)
    expect(useEmbeddingStore.getState().busy).toBeNull()
  })
})

describe('useLocalEmbeddingModel', () => {
  it('is the running model by its file, not by an id a catalog model shares', () => {
    useEmbeddingStore.setState({
      config: { enabled: true, model_path: MODEL_PATH } as EmbeddingConfig,
      status: { state: 'ready' } as never,
    })
    const { result } = renderHook(() => useLocalEmbeddingModel(local))
    expect(result.current.active).toBe(false)
    expect(result.current.state).toBeNull()
  })

  it('starts the file where it lies and raises the server, busy apart from the catalog row', async () => {
    let busyDuring: string | null = null
    lib.activateLocalEmbeddingModel.mockImplementation(async () => {
      busyDuring = useEmbeddingStore.getState().busy
      return { state: 'ready' }
    })
    const { result } = renderHook(() => useLocalEmbeddingModel(local))
    await act(async () => {
      await result.current.activate()
    })
    expect(lib.activateLocalEmbeddingModel).toHaveBeenCalledWith(local)
    expect(busyDuring).toBe('llamacpp-upstream:bge-m3')
    expect(raiseServer).toHaveBeenCalledOnce()
  })
})

describe('useLocalEmbeddingModels', () => {
  it("reads the llama.cpp models the extension flagged, skipping missing weights and other providers'", async () => {
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          models: [
            { id: 'sentence-transformer-mini', embedding: true },
            { id: 'qwen3-4b', embedding: false },
            { id: 'gone', embedding: true, missing: true },
            { id: 'nomic', displayName: 'Nomic Embed', embedding: true },
          ],
        },
        { provider: 'llamacpp', models: [{ id: 'other', embedding: true }] },
      ] as never,
    })
    lib.readLocalEmbeddingModel.mockImplementation(
      async (id: string, name: string) =>
        id === 'nomic'
          ? null
          : {
              id,
              name,
              model_path: `llamacpp/models/${id}/m.gguf`,
              mmproj_path: '',
            }
    )
    const { result } = renderHook(() => useLocalEmbeddingModels())
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(lib.readLocalEmbeddingModel.mock.calls).toEqual([
      ['sentence-transformer-mini', 'sentence-transformer-mini'],
      ['nomic', 'Nomic Embed'],
    ])
    expect(result.current[0]).toMatchObject({
      id: 'sentence-transformer-mini',
      model_path: 'llamacpp/models/sentence-transformer-mini/m.gguf',
    })
  })
})

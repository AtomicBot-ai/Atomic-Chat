import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  rm: vi.fn(),
}))

const transfer = vi.hoisted(() => ({
  transferFiles: vi.fn(),
  emitTransferProgress: vi.fn(),
  emitTransferSuccess: vi.fn(),
  emitTransferError: vi.fn(),
  emitTransferValidationFailed: vi.fn(),
  downloadProxyConfig: vi.fn(),
}))

vi.mock('@janhq/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@janhq/core')>()),
  fs: fsMock,
}))

vi.mock('@/services/diffusion/transfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/diffusion/transfer')>()),
  ...transfer,
}))

import { seedServiceHub } from '@/test/service-hub'
import type { AppService } from '@/services/app/types'
import type { EmbeddingCatalogModel } from '@/services/embedding-catalog-registry'
import type { EmbeddingService } from '@/services/embedding/types'

import {
  activateEmbeddingModel,
  activateLocalEmbeddingModel,
  deleteEmbeddingModel,
  downloadEmbeddingModel,
  EMBEDDING_STARTUP_TIMEOUT_SECS,
  embeddingDownloadTaskId,
  embeddingModelDir,
  embeddingModelPath,
  embeddingProjectorPath,
  isActiveEmbeddingModel,
  isActiveLocalEmbeddingModel,
  isEmbeddingDownloadTaskId,
  isEmbeddingModelInstalled,
  missingEmbeddingFiles,
  readLocalEmbeddingModel,
  stopEmbeddingModel,
} from '../models'

const HASH = 'a'.repeat(64)

/** A text model: one GGUF. */
const text: EmbeddingCatalogModel = {
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
    { path: 'bge-m3-q8_0.gguf', role: 'model', bytes: 600, sha256: HASH },
  ],
}

/** A model that reads images and audio: a GGUF and its projector. */
const multimodal: EmbeddingCatalogModel = {
  id: 'embeddinggemma-2',
  name: 'EmbeddingGemma 2',
  description: 'Google multimodal embedding model.',
  repo: 'unsloth/embeddinggemma-2-GGUF',
  revision: 'c'.repeat(40),
  params: '740M',
  languages: 'multilingual',
  context: 4096,
  max_context: 8192,
  dims: 768,
  matryoshka_dims: [512, 256, 128],
  pooling: 'mean',
  modalities: ['text', 'image', 'audio'],
  image_max_tokens: 280,
  license: 'apache-2.0',
  default: true,
  min_engine: 'b11454',
  engine: 'llamacpp-upstream',
  format: 'gguf',
  icon: 'gemma-mark',
  files: [
    {
      path: 'embeddinggemma-2-Q8_0.gguf',
      role: 'model',
      bytes: 300,
      sha256: HASH,
    },
    { path: 'mmproj-Q8_0.gguf', role: 'mmproj', bytes: 500, sha256: HASH },
  ],
}

const onDisk = (...relative: string[]) => {
  const present = new Set(relative.map((path) => `file://${path}`))
  fsMock.existsSync.mockImplementation(async (path: string) =>
    present.has(path)
  )
}

const embeddingService = (readYaml?: AppService['readYaml']) => {
  const service = {
    isSupported: () => true,
    setConfig: vi.fn().mockResolvedValue({}),
    load: vi.fn().mockResolvedValue({ state: 'ready' }),
  }
  seedServiceHub({
    embedding: service as unknown as EmbeddingService,
    ...(readYaml ? { app: { readYaml } as unknown as AppService } : {}),
  })
  return service
}

beforeEach(() => {
  vi.clearAllMocks()
  fsMock.existsSync.mockResolvedValue(false)
  fsMock.rm.mockResolvedValue(undefined)
  transfer.transferFiles.mockResolvedValue(undefined)
  transfer.downloadProxyConfig.mockReturnValue(undefined)
})

describe('paths and ids', () => {
  it('keeps a model under embedding/models/<id>, apart from the chat models', () => {
    expect(embeddingModelDir('bge-m3')).toBe('embedding/models/bge-m3')
    expect(embeddingModelPath(text)).toBe(
      'embedding/models/bge-m3/bge-m3-q8_0.gguf'
    )
    expect(embeddingProjectorPath(text)).toBe('')
    expect(embeddingProjectorPath(multimodal)).toBe(
      'embedding/models/embeddinggemma-2/mmproj-Q8_0.gguf'
    )
  })

  it('gives each model its own download task id', () => {
    expect(embeddingDownloadTaskId('nomic-embed-text-v1.5')).toBe(
      'embedding-nomic-embed-text-v1_5'
    )
    expect(isEmbeddingDownloadTaskId(embeddingDownloadTaskId('bge-m3'))).toBe(
      true
    )
    expect(isEmbeddingDownloadTaskId('decision-laya')).toBe(false)
    expect(isEmbeddingDownloadTaskId('sentence-transformer-mini')).toBe(false)
  })

  it('reads the active model off the configured file', () => {
    expect(
      isActiveEmbeddingModel(
        { model_path: 'embedding/models/bge-m3/bge-m3-q8_0.gguf' },
        text
      )
    ).toBe(true)
    expect(
      isActiveEmbeddingModel({ model_path: 'embedding/models/bge-m3' }, text)
    ).toBe(false)
    expect(isActiveEmbeddingModel({ model_path: '' }, text)).toBe(false)
    expect(isActiveEmbeddingModel(null, text)).toBe(false)
  })
})

describe('install state', () => {
  it('lists only the files not on disk, the projector included', async () => {
    onDisk('embedding/models/embeddinggemma-2/embeddinggemma-2-Q8_0.gguf')
    expect(
      (await missingEmbeddingFiles(multimodal)).map((f) => f.path)
    ).toEqual(['mmproj-Q8_0.gguf'])
    expect(await isEmbeddingModelInstalled(multimodal)).toBe(false)
  })

  it('is installed once every file is there', async () => {
    onDisk(
      'embedding/models/embeddinggemma-2/embeddinggemma-2-Q8_0.gguf',
      'embedding/models/embeddinggemma-2/mmproj-Q8_0.gguf'
    )
    expect(await isEmbeddingModelInstalled(multimodal)).toBe(true)
  })

  it('treats a failing check as a missing file', async () => {
    fsMock.existsSync.mockRejectedValue(new Error('ipc down'))
    expect(await missingEmbeddingFiles(multimodal)).toHaveLength(2)
  })
})

describe('downloadEmbeddingModel', () => {
  it('fetches every missing file from the pinned revision with its checks', async () => {
    await downloadEmbeddingModel(multimodal, { hfToken: 'hf_x', resume: true })

    const [items, taskId, options] = transfer.transferFiles.mock.calls[0]
    expect(taskId).toBe('embedding-embeddinggemma-2')
    expect(items).toEqual([
      {
        url: `https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/${'c'.repeat(40)}/embeddinggemma-2-Q8_0.gguf`,
        save_path:
          'embedding/models/embeddinggemma-2/embeddinggemma-2-Q8_0.gguf',
        sha256: HASH,
        size: 300,
        model_id: 'embedding-embeddinggemma-2',
      },
      {
        url: `https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/${'c'.repeat(40)}/mmproj-Q8_0.gguf`,
        save_path: 'embedding/models/embeddinggemma-2/mmproj-Q8_0.gguf',
        sha256: HASH,
        size: 500,
        model_id: 'embedding-embeddinggemma-2',
      },
    ])
    expect(options).toMatchObject({ resume: true, hfToken: 'hf_x' })
    expect(transfer.emitTransferProgress).toHaveBeenCalledWith(
      'embedding-embeddinggemma-2',
      'Model',
      0,
      800
    )
    expect(transfer.emitTransferSuccess).toHaveBeenCalledWith(
      'embedding-embeddinggemma-2',
      'Model',
      800
    )
  })

  it('passes the proxy setting through', async () => {
    transfer.downloadProxyConfig.mockReturnValue({ url: 'http://proxy' })
    await downloadEmbeddingModel(text)
    const [items] = transfer.transferFiles.mock.calls[0]
    expect(items[0].proxy).toEqual({ url: 'http://proxy' })
  })

  it('does nothing when every file is on disk', async () => {
    fsMock.existsSync.mockResolvedValue(true)
    await expect(downloadEmbeddingModel(text)).resolves.toBeUndefined()
    expect(transfer.transferFiles).not.toHaveBeenCalled()
  })

  it('reports a failed hash check as a validation failure', async () => {
    const error = new Error('Hash verification failed for bge-m3-q8_0.gguf')
    transfer.transferFiles.mockRejectedValue(error)
    await expect(downloadEmbeddingModel(text)).rejects.toBe(error)
    expect(transfer.emitTransferValidationFailed).toHaveBeenCalledWith(
      'embedding-bge-m3',
      error
    )
    expect(transfer.emitTransferSuccess).not.toHaveBeenCalled()
  })

  it('reports any other failure as a transfer error', async () => {
    const error = new Error('HTTP status 500')
    transfer.transferFiles.mockRejectedValue(error)
    await expect(downloadEmbeddingModel(text)).rejects.toBe(error)
    expect(transfer.emitTransferError).toHaveBeenCalledWith(
      'embedding-bge-m3',
      'Model',
      error
    )
  })
})

describe('core control', () => {
  it('points the core at the GGUF, its projector, context, pooling and image budget, then starts it', async () => {
    const service = embeddingService()
    await expect(activateEmbeddingModel(multimodal)).resolves.toEqual({
      state: 'ready',
    })
    expect(service.setConfig).toHaveBeenCalledWith({
      enabled: true,
      model_path:
        'embedding/models/embeddinggemma-2/embeddinggemma-2-Q8_0.gguf',
      mmproj_path: 'embedding/models/embeddinggemma-2/mmproj-Q8_0.gguf',
      model_id: 'embeddinggemma-2',
      ctx_size: 4096,
      pooling: 'mean',
      image_max_tokens: 280,
      startup_timeout_secs: EMBEDDING_STARTUP_TIMEOUT_SECS,
    })
    expect(EMBEDDING_STARTUP_TIMEOUT_SECS).toBe(300)
    expect(service.load).toHaveBeenCalledOnce()
    expect(service.setConfig.mock.invocationCallOrder[0]).toBeLessThan(
      service.load.mock.invocationCallOrder[0]
    )
  })

  it("clears a previous model's projector and image budget for a text model", async () => {
    const service = embeddingService()
    await activateEmbeddingModel(text)
    const [patch] = service.setConfig.mock.calls[0]
    expect(patch).toMatchObject({
      mmproj_path: '',
      image_max_tokens: 0,
      pooling: 'cls',
      ctx_size: 8192,
    })
  })

  it('stops by turning the model off', async () => {
    const service = embeddingService()
    await expect(stopEmbeddingModel()).resolves.toBeUndefined()
    expect(service.setConfig).toHaveBeenCalledWith({ enabled: false })
  })

  it('clears an active model from the core before deleting its folder', async () => {
    const service = embeddingService()
    fsMock.existsSync.mockResolvedValue(true)
    await deleteEmbeddingModel(text, {
      model_path: 'embedding/models/bge-m3/bge-m3-q8_0.gguf',
    })
    expect(service.setConfig).toHaveBeenCalledWith({
      enabled: false,
      model_path: '',
      mmproj_path: '',
      model_id: '',
    })
    expect(fsMock.rm).toHaveBeenCalledWith('file://embedding/models/bge-m3')
    expect(service.setConfig.mock.invocationCallOrder[0]).toBeLessThan(
      fsMock.rm.mock.invocationCallOrder[0]
    )
  })

  it('leaves the core alone when another model is active', async () => {
    const service = embeddingService()
    fsMock.existsSync.mockResolvedValue(true)
    await expect(
      deleteEmbeddingModel(text, {
        model_path: 'embedding/models/embeddinggemma-2/x.gguf',
      })
    ).resolves.toBeUndefined()
    expect(service.setConfig).not.toHaveBeenCalled()
    expect(fsMock.rm).toHaveBeenCalledOnce()
  })

  it('skips a folder that is already gone', async () => {
    embeddingService()
    await expect(deleteEmbeddingModel(text, null)).resolves.toBeUndefined()
    expect(fsMock.rm).not.toHaveBeenCalled()
  })
})

describe('llama.cpp models served as the embedding model', () => {
  it('reads the paths its model.yml names', async () => {
    const readYaml = vi.fn().mockResolvedValue({
      model_path: 'llamacpp/models/nomic/model.gguf',
      mmproj_path: 'llamacpp/models/nomic/mmproj.gguf',
    })
    embeddingService(readYaml as AppService['readYaml'])
    await expect(readLocalEmbeddingModel('nomic', 'Nomic')).resolves.toEqual({
      id: 'nomic',
      name: 'Nomic',
      model_path: 'llamacpp/models/nomic/model.gguf',
      mmproj_path: 'llamacpp/models/nomic/mmproj.gguf',
    })
    expect(readYaml).toHaveBeenCalledWith('llamacpp/models/nomic/model.yml')
  })

  it('has nothing to serve without a model.yml or a model file in it', async () => {
    const readYaml = vi
      .fn()
      .mockResolvedValueOnce({ name: 'no file' })
      .mockRejectedValueOnce(new Error('not found'))
    embeddingService(readYaml as AppService['readYaml'])
    await expect(readLocalEmbeddingModel('a', 'A')).resolves.toBeNull()
    await expect(readLocalEmbeddingModel('b', 'B')).resolves.toBeNull()
  })

  it('serves the file where it lies, under its provider id, with its own settings', async () => {
    const service = embeddingService()
    const local = {
      id: 'sentence-transformer-mini',
      name: 'sentence-transformer-mini',
      model_path: '/Users/me/models/all-MiniLM-L6-v2.gguf',
      mmproj_path: '',
    }
    await activateLocalEmbeddingModel(local)
    expect(service.setConfig).toHaveBeenCalledWith({
      enabled: true,
      model_path: '/Users/me/models/all-MiniLM-L6-v2.gguf',
      mmproj_path: '',
      model_id: 'sentence-transformer-mini',
      ctx_size: 0,
      pooling: '',
      image_max_tokens: 0,
      startup_timeout_secs: EMBEDDING_STARTUP_TIMEOUT_SECS,
    })
    expect(service.load).toHaveBeenCalledOnce()
    expect(
      isActiveLocalEmbeddingModel(
        { model_path: '/Users/me/models/all-MiniLM-L6-v2.gguf' },
        local
      )
    ).toBe(true)
    expect(isActiveLocalEmbeddingModel(null, local)).toBe(false)
  })
})

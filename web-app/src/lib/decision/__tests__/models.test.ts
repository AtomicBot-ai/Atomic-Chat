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
import type { DecisionCatalogModel } from '@/services/decision-catalog-registry'
import type { DecisionService } from '@/services/decision/types'

import {
  activateDecisionModel,
  decisionDownloadTaskId,
  decisionModelDir,
  decisionModelPath,
  decisionStartupTimeoutSecs,
  deleteDecisionModel,
  downloadDecisionModel,
  isActiveDecisionModel,
  isDecisionDownloadTaskId,
  isDecisionModelInstalled,
  missingDecisionFiles,
  stopDecisionModel,
} from '../models'

const HASH = 'a'.repeat(64)

const model: DecisionCatalogModel = {
  id: 'laya-multilingual',
  name: 'Laya Multilingual',
  repo: 'systemone/laya-multilingual',
  revision: 'b'.repeat(40),
  languages: 'multilingual',
  context: 8192,
  calibrated: false,
  engine: 'llamacpp',
  format: 'checkpoint',
  files: [
    { path: 'rl_agent_config.json', bytes: 100, sha256: HASH },
    { path: 'model/model.safetensors', bytes: 900, sha256: HASH },
  ],
}

/** A stock llama.cpp model: a GGUF and its projector. */
const gguf: DecisionCatalogModel = {
  id: 'clef-flash',
  name: 'Clef Flash',
  repo: 'ggml-org/Clef-Flash-GGUF',
  revision: 'c'.repeat(40),
  languages: 'en',
  context: 8192,
  calibrated: false,
  engine: 'llamacpp-upstream',
  format: 'gguf',
  decision_type: 'clef',
  vision: true,
  min_engine: 'b11418',
  files: [
    {
      path: 'Clef-Flash-Q4_K_M.gguf',
      role: 'model',
      bytes: 6000,
      sha256: HASH,
    },
    {
      path: 'mmproj-Clef-Flash-Q8_0.gguf',
      role: 'mmproj',
      bytes: 600,
      sha256: HASH,
    },
  ],
}

const onDisk = (...relative: string[]) => {
  const present = new Set(relative.map((path) => `file://${path}`))
  fsMock.existsSync.mockImplementation(async (path: string) =>
    present.has(path)
  )
}

const decisionService = () => {
  const service = {
    isSupported: () => true,
    setConfig: vi.fn().mockResolvedValue({}),
    load: vi.fn().mockResolvedValue({ state: 'ready' }),
  }
  seedServiceHub({ decision: service as unknown as DecisionService })
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
  it('keeps a model under decision/models/<id>', () => {
    expect(decisionModelDir('laya')).toBe('decision/models/laya')
  })

  it('gives each model its own download task id', () => {
    expect(decisionDownloadTaskId('laya.v2')).toBe('decision-laya_v2')
    expect(isDecisionDownloadTaskId(decisionDownloadTaskId('laya'))).toBe(true)
    expect(isDecisionDownloadTaskId('llamacpp-b100')).toBe(false)
  })

  it('reads the active model off the configured path', () => {
    expect(
      isActiveDecisionModel(
        { model_path: 'decision/models/laya-multilingual' },
        model
      )
    ).toBe(true)
    expect(isActiveDecisionModel({ model_path: '' }, model)).toBe(false)
    expect(isActiveDecisionModel(null, model)).toBe(false)
    // A GGUF model is active by its file, not its folder.
    expect(
      isActiveDecisionModel(
        { model_path: 'decision/models/clef-flash/Clef-Flash-Q4_K_M.gguf' },
        gguf
      )
    ).toBe(true)
    expect(
      isActiveDecisionModel({ model_path: 'decision/models/clef-flash' }, gguf)
    ).toBe(false)
  })

  it('points the core at the folder of a checkpoint, the -m file of a GGUF', () => {
    expect(decisionModelPath(model)).toBe('decision/models/laya-multilingual')
    expect(decisionModelPath(gguf)).toBe(
      'decision/models/clef-flash/Clef-Flash-Q4_K_M.gguf'
    )
    expect(decisionStartupTimeoutSecs(model)).toBe(60)
    expect(decisionStartupTimeoutSecs(gguf)).toBe(600)
  })
})

describe('install state', () => {
  it('lists only the files not on disk', async () => {
    onDisk('decision/models/laya-multilingual/rl_agent_config.json')
    expect((await missingDecisionFiles(model)).map((f) => f.path)).toEqual([
      'model/model.safetensors',
    ])
    expect(await isDecisionModelInstalled(model)).toBe(false)
  })

  it('is installed once every file is there', async () => {
    onDisk(
      'decision/models/laya-multilingual/rl_agent_config.json',
      'decision/models/laya-multilingual/model/model.safetensors'
    )
    expect(await isDecisionModelInstalled(model)).toBe(true)
  })

  it('treats a failing check as a missing file', async () => {
    fsMock.existsSync.mockRejectedValue(new Error('ipc down'))
    expect(await missingDecisionFiles(model)).toHaveLength(2)
  })
})

describe('downloadDecisionModel', () => {
  it('fetches the missing files from the pinned revision with their checks', async () => {
    onDisk('decision/models/laya-multilingual/rl_agent_config.json')
    await downloadDecisionModel(model, { hfToken: 'hf_x', resume: true })

    const [items, taskId, options] = transfer.transferFiles.mock.calls[0]
    expect(taskId).toBe('decision-laya-multilingual')
    expect(items).toEqual([
      {
        url: `https://huggingface.co/systemone/laya-multilingual/resolve/${'b'.repeat(40)}/model/model.safetensors`,
        save_path: 'decision/models/laya-multilingual/model/model.safetensors',
        sha256: HASH,
        size: 900,
        model_id: 'decision-laya-multilingual',
      },
    ])
    expect(options).toMatchObject({ resume: true, hfToken: 'hf_x' })
    expect(transfer.emitTransferProgress).toHaveBeenCalledWith(
      'decision-laya-multilingual',
      'Model',
      0,
      900
    )
    expect(transfer.emitTransferSuccess).toHaveBeenCalledWith(
      'decision-laya-multilingual',
      'Model',
      900
    )
  })

  it('passes the proxy setting through', async () => {
    transfer.downloadProxyConfig.mockReturnValue({ url: 'http://proxy' })
    await downloadDecisionModel(model)
    const [items] = transfer.transferFiles.mock.calls[0]
    expect(items[0].proxy).toEqual({ url: 'http://proxy' })
  })

  it('does nothing when every file is on disk', async () => {
    fsMock.existsSync.mockResolvedValue(true)
    await expect(downloadDecisionModel(model)).resolves.toBeUndefined()
    expect(transfer.transferFiles).not.toHaveBeenCalled()
  })

  it('reports a failed hash check as a validation failure', async () => {
    const error = new Error('Hash verification failed for model.safetensors')
    transfer.transferFiles.mockRejectedValue(error)
    await expect(downloadDecisionModel(model)).rejects.toBe(error)
    expect(transfer.emitTransferValidationFailed).toHaveBeenCalledWith(
      'decision-laya-multilingual',
      error
    )
    expect(transfer.emitTransferSuccess).not.toHaveBeenCalled()
  })

  it('reports any other failure as a transfer error', async () => {
    const error = new Error('HTTP status 500')
    transfer.transferFiles.mockRejectedValue(error)
    await expect(downloadDecisionModel(model)).rejects.toBe(error)
    expect(transfer.emitTransferError).toHaveBeenCalledWith(
      'decision-laya-multilingual',
      'Model',
      error
    )
  })
})

describe('core control', () => {
  it('points the core at the folder, then starts it', async () => {
    const service = decisionService()
    await activateDecisionModel(model)
    expect(service.setConfig).toHaveBeenCalledWith({
      enabled: true,
      model_path: 'decision/models/laya-multilingual',
      model_id: 'laya-multilingual',
      mmproj_path: '',
      ctx_size: 0,
      startup_timeout_secs: 60,
    })
    expect(service.load).toHaveBeenCalledOnce()
    expect(service.setConfig.mock.invocationCallOrder[0]).toBeLessThan(
      service.load.mock.invocationCallOrder[0]
    )
  })

  it('points the core at a GGUF, its projector and its context for stock llama.cpp', async () => {
    const service = decisionService()
    await expect(activateDecisionModel(gguf)).resolves.toEqual({
      state: 'ready',
    })
    expect(service.setConfig).toHaveBeenCalledWith({
      enabled: true,
      model_path: 'decision/models/clef-flash/Clef-Flash-Q4_K_M.gguf',
      model_id: 'clef-flash',
      mmproj_path: 'decision/models/clef-flash/mmproj-Clef-Flash-Q8_0.gguf',
      ctx_size: 8192,
      startup_timeout_secs: 600,
    })
  })

  it('stops by turning the model off', async () => {
    const service = decisionService()
    await expect(stopDecisionModel()).resolves.toBeUndefined()
    expect(service.setConfig).toHaveBeenCalledWith({ enabled: false })
  })

  it('clears an active model from the core before deleting its folder', async () => {
    const service = decisionService()
    fsMock.existsSync.mockResolvedValue(true)
    await deleteDecisionModel(model, {
      model_path: 'decision/models/laya-multilingual',
    })
    expect(service.setConfig).toHaveBeenCalledWith({
      enabled: false,
      model_path: '',
      model_id: '',
      mmproj_path: '',
    })
    expect(fsMock.rm).toHaveBeenCalledWith(
      'file://decision/models/laya-multilingual'
    )
    expect(service.setConfig.mock.invocationCallOrder[0]).toBeLessThan(
      fsMock.rm.mock.invocationCallOrder[0]
    )
  })

  it('leaves the core alone when another model is active', async () => {
    const service = decisionService()
    fsMock.existsSync.mockResolvedValue(true)
    await expect(
      deleteDecisionModel(model, { model_path: 'decision/models/laya' })
    ).resolves.toBeUndefined()
    expect(service.setConfig).not.toHaveBeenCalled()
    expect(fsMock.rm).toHaveBeenCalledOnce()
  })

  it('skips a folder that is already gone', async () => {
    decisionService()
    await expect(deleteDecisionModel(model, null)).resolves.toBeUndefined()
    expect(fsMock.rm).not.toHaveBeenCalled()
  })
})

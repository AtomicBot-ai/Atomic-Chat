import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import type { ServiceHub } from '@/services'

import {
  cancelDownload,
  isDownloadCancellationError,
  wasDownloadCancellationRequested,
} from './downloadCancellation'

const abortDownload = vi.fn(() => Promise.resolve())
const extensionCancel = vi.fn()
const cancelEngineBuildDownload = vi.fn<(taskId: string) => Promise<void>>(() =>
  Promise.resolve()
)
vi.mock('@/services/engine-builds/core', () => ({
  cancelEngineBuildDownload: (taskId: string) =>
    cancelEngineBuildDownload(taskId),
}))

const serviceHub = {
  models: () => ({ abortDownload }),
} as unknown as ServiceHub

/**
 * The branching the bottom-right panel used to keep to itself. The composer's
 * reply widget offers the same Cancel now, so the two must stop a transfer
 * the same way.
 */
describe('cancelDownload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as Record<string, unknown>).core = {
      extensionManager: {
        getByName: () => ({ cancelDownload: extensionCancel }),
      },
    }
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      dismissedDownloads: new Set(),
      resumableDownloads: new Set(),
      pausedDownloads: new Set(['LiquidAI/LFM2.5-1.2B-Q4_K_M']),
      resumeParams: {
        'LiquidAI/LFM2.5-1.2B-Q4_K_M': { modelPath: 'https://example.test/x' },
      },
    })
  })

  it('cancels a model job and hides it without discarding its resumable source', () => {
    const id = 'LiquidAI/LFM2.5-1.2B-Q4_K_M'

    cancelDownload({ id, name: id }, serviceHub)

    expect(abortDownload).toHaveBeenCalledWith(id)
    expect(extensionCancel).not.toHaveBeenCalled()
    const state = useDownloadStore.getState()
    expect(state.resumableDownloads.has(id)).toBe(true)
    expect(state.pausedDownloads.has(id)).toBe(false)
    expect(state.dismissedDownloads.has(id)).toBe(true)
    expect(state.downloads[id]).toBeUndefined()
    expect(state.resumeParams).toHaveProperty(id)
    // The stop event that follows is read as a cancel, not a failure.
    expect(wasDownloadCancellationRequested(id)).toBe(true)
  })

  it('cancels backend binaries and MLX repos through the download extension', () => {
    cancelDownload(
      { id: 'llamacpp-backend-b1', name: 'llamacpp-backend-b1' },
      serviceHub
    )
    cancelDownload(
      { id: 'mlx-community/Qwen3-4bit', name: 'mlx-community/Qwen3-4bit' },
      serviceHub
    )

    expect(extensionCancel.mock.calls.map(([id]) => id)).toEqual([
      'llamacpp-backend-b1',
      'mlx-community/Qwen3-4bit',
    ])
    expect(abortDownload).not.toHaveBeenCalled()
    expect(
      useDownloadStore.getState().resumableDownloads.has('llamacpp-backend-b1')
    ).toBe(true)
  })

  it('cancels diffusion artifacts through their download-extension task id', () => {
    const id = 'diffusion-model-flux_1-nsfw-realism_q8_0'

    cancelDownload({ id, name: id }, serviceHub)

    expect(extensionCancel).toHaveBeenCalledWith(id)
    expect(abortDownload).not.toHaveBeenCalled()
    expect(useDownloadStore.getState().resumableDownloads.has(id)).toBe(true)
    expect(wasDownloadCancellationRequested(id)).toBe(true)
  })

  it('clears a paused checkpoint’s row itself: no transfer is left to report a stop', () => {
    const id = 'diffusion-model-z-image_q4_k_m'
    useDownloadStore.setState({
      downloads: {
        [id]: {
          id,
          name: id,
          progress: 0.4,
          current: 4,
          total: 10,
          speed: { bytesPerSecond: 0, atBytes: 4, atTime: 0 },
        },
      },
      pausedDownloads: new Set([id]),
    })

    cancelDownload({ id, name: id }, serviceHub)

    const state = useDownloadStore.getState()
    expect(state.downloads).not.toHaveProperty(id)
    expect(state.pausedDownloads.has(id)).toBe(false)
    // Pause already stopped the transfer; asking again only fails.
    expect(extensionCancel).not.toHaveBeenCalled()
    expect(state.resumableDownloads.has(id)).toBe(true)
  })

  it('clears a paused chat-model row and still lets the model service report the cancel', () => {
    const id = 'LiquidAI/LFM2.5-1.2B-Q4_K_M'
    useDownloadStore.setState({
      downloads: {
        [id]: {
          id,
          name: id,
          progress: 0.4,
          current: 4,
          total: 10,
          speed: { bytesPerSecond: 0, atBytes: 4, atTime: 0 },
        },
      },
    })

    cancelDownload({ id, name: id }, serviceHub)

    expect(useDownloadStore.getState().downloads).not.toHaveProperty(id)
    expect(abortDownload).toHaveBeenCalledWith(id)
  })

  it('stops a Foundry Local variant’s transfer by its task id (change add-foundry-local)', () => {
    const id = 'foundry-local-qwen3-0_6b-generic-gpu'

    cancelDownload({ id, name: id }, serviceHub)

    // `cancelTransfer`: the download extension's task, not the chat-model abort.
    expect(extensionCancel).toHaveBeenCalledWith(id)
    expect(abortDownload).not.toHaveBeenCalled()
    expect(wasDownloadCancellationRequested(id)).toBe(true)
  })

  it('stops a LiteRT-LM variant’s transfer by its task id (change add-litert-lm-runtime)', () => {
    const id = 'litert-lm-gemma-4-e4b-gpu'

    cancelDownload({ id, name: id }, serviceHub)

    expect(extensionCancel).toHaveBeenCalledWith(id)
    expect(abortDownload).not.toHaveBeenCalled()
    expect(wasDownloadCancellationRequested(id)).toBe(true)
  })

  it('stops an engine update in the core by its task id', () => {
    const id = 'engine-update-llamacpp-upstream-b11500'

    cancelDownload({ id, name: id }, serviceHub)

    expect(cancelEngineBuildDownload).toHaveBeenCalledWith(id)
    expect(extensionCancel).not.toHaveBeenCalled()
    expect(abortDownload).not.toHaveBeenCalled()
    expect(useDownloadStore.getState().resumableDownloads.has(id)).toBe(true)
    expect(wasDownloadCancellationRequested(id)).toBe(true)
  })

  it('marks both keys when the row id and the transfer name differ', () => {
    cancelDownload({ id: 'row-id', name: 'transfer-name' }, serviceHub)

    expect(abortDownload).toHaveBeenCalledWith('transfer-name')
    expect(wasDownloadCancellationRequested('row-id')).toBe(true)
    expect(wasDownloadCancellationRequested('transfer-name')).toBe(true)
  })
})

describe('isDownloadCancellationError', () => {
  it.each([
    new Error('Download cancelled'),
    'operation aborted by user',
    'transfer stopped',
  ])(
    'recognises a user cancellation without treating it as a failure',
    (error) => {
      expect(isDownloadCancellationError(error)).toBe(true)
    }
  )

  it('does not hide a real download failure', () => {
    expect(isDownloadCancellationError(new Error('HTTP status 500'))).toBe(
      false
    )
  })
})

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
      resumableDownloads: new Set(),
      pausedDownloads: new Set(['LiquidAI/LFM2.5-1.2B-Q4_K_M']),
      resumeParams: {
        'LiquidAI/LFM2.5-1.2B-Q4_K_M': { modelPath: 'https://example.test/x' },
      },
    })
  })

  it('aborts a model file through the model service and leaves it resumable', () => {
    const id = 'LiquidAI/LFM2.5-1.2B-Q4_K_M'

    cancelDownload({ id, name: id }, serviceHub)

    expect(abortDownload).toHaveBeenCalledWith(id)
    expect(extensionCancel).not.toHaveBeenCalled()
    const state = useDownloadStore.getState()
    expect(state.resumableDownloads.has(id)).toBe(true)
    expect(state.pausedDownloads.has(id)).toBe(false)
    expect(state.resumeParams).not.toHaveProperty(id)
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

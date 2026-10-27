import { beforeEach, describe, expect, it, vi } from 'vitest'

const transfer = vi.hoisted(() => ({ cancelTransfer: vi.fn() }))
vi.mock('@/services/diffusion/transfer', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cancelTransfer: transfer.cancelTransfer,
}))

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { diffusionDownloadTaskId } from '@/lib/diffusion/models'
import type { ServiceHub } from '@/services'

import { isPausableDownload, pauseDownload } from '../downloadControls'

const abortDownload = vi.fn()
const serviceHub = {
  models: () => ({ abortDownload }),
} as unknown as ServiceHub

describe('download controls', () => {
  beforeEach(() => {
    abortDownload.mockReset()
    transfer.cancelTransfer.mockReset()
    useDownloadStore.setState({
      downloads: {},
      resumeParams: {},
      pausedDownloads: new Set(),
      resumableDownloads: new Set(),
    })
  })

  it('offers Pause on model downloads and on image/video model files', () => {
    expect(isPausableDownload('Qwen3.5-4B-Q4_K_M')).toBe(true)
    expect(isPausableDownload(diffusionDownloadTaskId('z-image:q4'))).toBe(true)
  })

  it('keeps backend builds and MLX repos cancel-only', () => {
    expect(isPausableDownload('llamacpp-b8000-macos-arm64')).toBe(false)
    expect(isPausableDownload('mlx-community/Qwen3-4B-4bit')).toBe(false)
  })

  it('offers the same Pause control for a journaled MLX request', () => {
    const id = 'mlx-community/Qwen3-4B-4bit'
    useDownloadStore.getState().setResumeParams(id, {
      provider: 'mlx',
      modelPath: 'https://huggingface.co/mlx-community/Qwen3-4B-4bit/resolve/main/model.safetensors',
    })
    expect(isPausableDownload(id)).toBe(true)
    pauseDownload({ id, name: id }, serviceHub)
    expect(useDownloadStore.getState().pausedDownloads.has(id)).toBe(true)
    expect(useDownloadStore.getState().resumableDownloads.has(id)).toBe(true)
  })

  it('pauses a model download so it can resume, under both of its ids', () => {
    pauseDownload(
      { id: 'Qwen3.5-4B-Q4_K_M', name: 'unsloth/Qwen3.5-4B-Q4_K_M' },
      serviceHub
    )

    const state = useDownloadStore.getState()
    expect([...state.pausedDownloads]).toEqual([
      'Qwen3.5-4B-Q4_K_M',
      'unsloth/Qwen3.5-4B-Q4_K_M',
    ])
    expect(state.resumableDownloads.has('Qwen3.5-4B-Q4_K_M')).toBe(true)
    expect(abortDownload).toHaveBeenCalledWith('unsloth/Qwen3.5-4B-Q4_K_M')
    expect(transfer.cancelTransfer).not.toHaveBeenCalled()
  })

  it('stops an image model file through its own transfer', () => {
    const id = diffusionDownloadTaskId('z-image:q4')
    pauseDownload({ id, name: id }, serviceHub)

    expect(useDownloadStore.getState().pausedDownloads.has(id)).toBe(true)
    expect(transfer.cancelTransfer).toHaveBeenCalledWith(id)
    expect(abortDownload).not.toHaveBeenCalled()
  })
})

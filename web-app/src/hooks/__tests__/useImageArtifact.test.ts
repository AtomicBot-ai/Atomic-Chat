import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeCatalog,
  makeFakeDiffusion,
  makeFilesFor,
  makeLoadedStatus,
  makeStatus,
  Q4_ID,
  Q8_ID,
  Z_IMAGE,
  type FakeDiffusion,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

// The download itself is the transfer module's job (tested there); the hook
// only has to start it and refresh what is on disk when it lands.
const transfer = vi.hoisted(() => ({
  download: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
}))
vi.mock('@/lib/diffusion/arbiter', () => ({
  acquireGpuForDiffusion: vi.fn(async () => ({ evicted: [] })),
}))
vi.mock('@/lib/diffusion/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/diffusion/config')>()),
  configureDiffusion: vi.fn(),
  getDiffusionPaths: vi.fn(async () => ({
    dataFolder: '/data',
    modelsRoot: '/data/diffusion/models',
    backendsRoot: '/data/diffusion/backends',
    imagesDir: '/data/images',
  })),
}))
vi.mock('@/lib/diffusion/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/diffusion/models')>()),
  downloadArtifact: transfer.download,
  cancelArtifactDownload: transfer.cancel,
}))

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { diffusionDownloadTaskId, listInstalledArtifacts } from '@/lib/diffusion/models'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useImageArtifact } from '../useImageArtifact'

describe('useImageArtifact', () => {
  let fake: FakeDiffusion
  const catalog = makeCatalog()
  const q4Files = makeFilesFor(Z_IMAGE, 'q4_k_m')

  beforeEach(() => {
    vi.clearAllMocks()
    fake = makeFakeDiffusion()
    seedServiceHub({ diffusion: fake })
    useDownloadStore.setState({ downloads: {} })
    useImageGenerationStore.getState().reset()
    useImageGenerationStore.setState({
      catalog,
      modelFiles: q4Files,
      installedArtifacts: listInstalledArtifacts(catalog, q4Files),
      status: makeStatus(),
      paths: {
        dataFolder: '/data',
        modelsRoot: '/data/diffusion/models',
        backendsRoot: '/data/diffusion/backends',
        imagesDir: '/data/images',
      },
    })
  })

  it('describes an installed quant: complete, sized with its side files, not loaded', () => {
    const { result } = renderHook(() => useImageArtifact(Q4_ID))
    expect(result.current.family?.name).toBe('Z-Image Turbo')
    expect(result.current.quant?.label).toBe('Q4_K_M')
    expect(result.current.complete).toBe(true)
    expect(result.current.downloading).toBe(false)
    expect(result.current.loaded).toBe(false)
    expect(result.current.totalBytes).toBe(4_000_000_000 + 300_000_000 + 2_500_000_000)
    expect(['ok', 'maybe', 'no']).toContain(result.current.fit)
  })

  it('knows a quant that is not on disk, and one the catalog does not list', () => {
    const missing = renderHook(() => useImageArtifact(Q8_ID))
    expect(missing.result.current.complete).toBe(false)
    expect(missing.result.current.installed).toBeNull()

    const unknown = renderHook(() => useImageArtifact('z-image:q2_k'))
    expect(unknown.result.current.family).not.toBeNull()
    expect(unknown.result.current.quant).toBeNull()
    expect(unknown.result.current.totalBytes).toBe(0)
  })

  it('reads its progress from the download panel entry', () => {
    const { result } = renderHook(() => useImageArtifact(Q8_ID))
    act(() => {
      useDownloadStore
        .getState()
        .updateProgress(diffusionDownloadTaskId(Q8_ID), 0.5, 'Q8_0', 500, 1000)
    })
    expect(result.current.downloading).toBe(true)
    expect(result.current.progress).toBe(0.5)
    expect(result.current.currentBytes).toBe(500)
    expect(result.current.downloadTotalBytes).toBe(1000)
  })

  it('marks the resident model as loaded', () => {
    useImageGenerationStore.setState({ status: makeLoadedStatus(Q4_ID) })
    const { result } = renderHook(() => useImageArtifact(Q4_ID))
    expect(result.current.loaded).toBe(true)
    const other = renderHook(() => useImageArtifact(Q8_ID))
    expect(other.result.current.loaded).toBe(false)
  })

  it('starts the download and picks up the files once they land', async () => {
    const q8Files = makeFilesFor(Z_IMAGE, 'q8_0')
    fake.listModelFiles.mockResolvedValue([...q4Files, ...q8Files])
    const { result } = renderHook(() => useImageArtifact(Q8_ID))
    expect(result.current.complete).toBe(false)

    await act(async () => {
      await result.current.download()
    })

    expect(transfer.download.mock.calls[0][0].id).toBe('z-image')
    expect(transfer.download.mock.calls[0][1]).toBe('q8_0')
    expect(result.current.complete).toBe(true)
    expect(result.current.installed?.missing).toEqual([])
  })

  it('loads through the store and reports as loaded afterwards', async () => {
    const { result } = renderHook(() => useImageArtifact(Q4_ID))
    await act(async () => {
      await result.current.load()
    })
    expect(fake.loadModel.mock.calls[0][0].modelId).toBe(Q4_ID)
    expect(result.current.loaded).toBe(true)
    expect(result.current.loading).toBe(false)
  })
})

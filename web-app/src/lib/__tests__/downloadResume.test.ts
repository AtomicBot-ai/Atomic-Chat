import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
const transfers = vi.hoisted(() => ({
  downloadArtifact: vi.fn(async () => ({})),
}))
vi.mock('@/lib/diffusion/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/diffusion/models')>()),
  downloadArtifact: transfers.downloadArtifact,
}))

import { localStorageKey } from '@/constants/localStorage'
import {
  useDownloadStore,
  type DownloadProgressProps,
} from '@/hooks/useDownloadStore'
import { artifactId, diffusionDownloadTaskId } from '@/lib/diffusion/models'
import { resumeDownload } from '@/lib/downloadResume'
import { persistInterruptedDownloads } from '@/lib/interrupted-downloads'
import type { ServiceHub } from '@/services'
import { getBaselineDiffusionCatalog } from '@/services/diffusion-catalog-registry'
import { useImageGenerationStore } from '@/stores/image-generation-store'

const t = (key: string) => key
const serviceHub = {
  models: () => ({ pullModelWithMetadata: vi.fn(async () => undefined) }),
} as unknown as ServiceHub

const catalog = getBaselineDiffusionCatalog()
const family = catalog.families.find((entry) => entry.modality === 'image')!
const CHECKPOINT = diffusionDownloadTaskId(
  artifactId(family.id, family.transformer.quants[0].id)
)

const row = (id: string): DownloadProgressProps => ({
  id,
  name: id,
  progress: 0.42,
  current: 42,
  total: 100,
  speed: { bytesPerSecond: 0, atBytes: 42, atTime: 0 },
})

let stopPersisting: () => void

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.removeItem(localStorageKey.interruptedDownloads)
  useDownloadStore.setState({
    downloads: {},
    localDownloadingModels: new Set(),
    resumableDownloads: new Set(),
    pausedDownloads: new Set(),
    resumeParams: {},
    downloadOriginByModelId: {},
  })
  stopPersisting = persistInterruptedDownloads()
})

afterEach(() => {
  stopPersisting()
  localStorage.removeItem(localStorageKey.interruptedDownloads)
})

/** A paused checkpoint row, as a relaunch brings it back. */
const pausedCheckpoint = () =>
  useDownloadStore.setState({
    downloads: { [CHECKPOINT]: row(CHECKPOINT) },
    localDownloadingModels: new Set([CHECKPOINT]),
    pausedDownloads: new Set([CHECKPOINT]),
    resumableDownloads: new Set([CHECKPOINT]),
  })

describe('resumeDownload for a download nothing can resume', () => {
  it.each([
    ['the catalog is not loaded', null],
    [
      'the catalog no longer lists the quant',
      {
        ...catalog,
        families: catalog.families.filter((entry) => entry.id !== family.id),
      },
    ],
  ])(
    'drops the row and its stored record when %s, and says so',
    (_, imageCatalog) => {
      useImageGenerationStore.setState({ catalog: imageCatalog })
      pausedCheckpoint()
      expect(
        localStorage.getItem(localStorageKey.interruptedDownloads)
      ).toContain(CHECKPOINT)

      resumeDownload({ id: CHECKPOINT, name: CHECKPOINT }, { serviceHub, t })

      const state = useDownloadStore.getState()
      // No row left looking like a running download with nothing behind it.
      expect(state.downloads).not.toHaveProperty(CHECKPOINT)
      expect(state.localDownloadingModels.has(CHECKPOINT)).toBe(false)
      expect(state.pausedDownloads.has(CHECKPOINT)).toBe(false)
      // The next launch does not bring it back either.
      expect(
        localStorage.getItem(localStorageKey.interruptedDownloads)
      ).toBeNull()
      // The bytes on disk stay usable by a fresh Download.
      expect(state.resumableDownloads.has(CHECKPOINT)).toBe(true)
      expect(transfers.downloadArtifact).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith(
        'common:toast.downloadNotResumable.title',
        { description: 'common:toast.downloadNotResumable.description' }
      )
    }
  )

  it('still resumes a checkpoint the catalog lists', () => {
    useImageGenerationStore.setState({
      catalog,
      refreshModelFiles: vi.fn(async () => {}),
    })
    pausedCheckpoint()

    resumeDownload({ id: CHECKPOINT, name: CHECKPOINT }, { serviceHub, t })

    expect(transfers.downloadArtifact).toHaveBeenCalledWith(
      family,
      family.transformer.quants[0].id,
      expect.objectContaining({ resume: true })
    )
    const state = useDownloadStore.getState()
    expect(state.downloads).toHaveProperty(CHECKPOINT)
    expect(state.pausedDownloads.has(CHECKPOINT)).toBe(false)
    expect(toast.error).not.toHaveBeenCalled()
  })
})

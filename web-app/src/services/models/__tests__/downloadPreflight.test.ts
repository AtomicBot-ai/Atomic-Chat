import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'

// Build-time globals the catalog registry reads; see services/__tests__/models.test.ts.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  g.IS_TAURI = true
  g.IS_MACOS = true
  g.IS_WINDOWS = false
  g.IS_LINUX = false
  g.DecompressionStream = undefined
})

const { mockEvents, mockDownloadEvent, mockToast, mockQueuedCapture } =
  vi.hoisted(() => ({
    mockEvents: { emit: vi.fn() },
    mockDownloadEvent: {
      onFileDownloadError: 'onFileDownloadError',
      onFileDownloadStopped: 'onFileDownloadStopped',
    } as Record<string, string>,
    mockToast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
    mockQueuedCapture: vi.fn(),
  }))

vi.mock('@janhq/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@janhq/core')>(),
  EngineManager: { instance: vi.fn() },
  events: mockEvents,
  DownloadEvent: mockDownloadEvent,
}))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
vi.mock('sonner', () => ({ toast: mockToast }))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: mockQueuedCapture }))

import { DefaultModelsService } from '../default'
import { EngineManager } from '@janhq/core'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelSources } from '@/hooks/useModelSources'
import type { CatalogModel } from '../types'
import { downloadHeadroomBytes, isFatFileSystem } from '../downloadPreflight'

const GB = 1024 ** 3
const MB = 1024 ** 2
const HEADROOM = 512 * MB

const BIG_PATH =
  'https://huggingface.co/acme/Big-GGUF/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/big-q4_k_m.gguf'
const BIG_MMPROJ_PATH =
  'https://huggingface.co/acme/Big-GGUF/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/mmproj-f16.gguf'
const SMALL_PATH =
  'https://huggingface.co/acme/Small-GGUF/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/small-q4_k_m.gguf'
const UNKNOWN_PATH =
  'https://huggingface.co/someone/Else-GGUF/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/else-q4_k_m.gguf'

const catalog: CatalogModel[] = [
  {
    model_name: 'acme/Big-GGUF',
    description: '',
    downloads: 0,
    quants: [{ model_id: 'big-q4_k_m', path: BIG_PATH, file_size: '6 GB' }],
    mmproj_models: [
      { model_id: 'mmproj-f16', path: BIG_MMPROJ_PATH, file_size: '800 MB' },
    ],
  },
  {
    model_name: 'acme/Small-GGUF',
    description: '',
    downloads: 0,
    quants: [
      { model_id: 'small-q4_k_m', path: SMALL_PATH, file_size: '400 MB' },
    ],
  },
]

type FreeSpace = { available: number | null; headroom: number }

const mockFreeSpace = (answer: FreeSpace | (() => never)) => {
  const ipc = vi.fn((command: string) => {
    if (command === 'get_download_free_space') {
      return typeof answer === 'function' ? answer() : answer
    }
    return undefined
  })
  mockIPC(ipc)
  return ipc
}

describe('pullModelWithMetadata disk-space preflight', () => {
  let service: DefaultModelsService
  const engine = { import: vi.fn().mockResolvedValue(undefined) }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sha: 'a'.repeat(40), siblings: [
      { rfilename: 'big-q4_k_m.gguf', size: 6 * GB },
      { rfilename: 'mmproj-f16.gguf', size: 800 * MB },
      { rfilename: 'small-q4_k_m.gguf', size: 400 * MB },
    ] })))
    ;(EngineManager.instance as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn().mockReturnValue(engine),
    })
    useModelSources.setState({ sources: catalog })
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      resumableDownloads: new Set(),
      pausedDownloads: new Set(),
      resumeParams: {},
      downloadOriginByModelId: {},
      downloadRequestOriginByModelId: {},
    })
    service = new DefaultModelsService()
  })

  afterEach(() => {
    clearMocks()
  })

  it('refuses a model that will not fit, says so once, and leaves nothing behind', async () => {
    // 6 GB model + 800 MB mmproj + 512 MB headroom on a drive with 2 GB free.
    mockFreeSpace({ available: 2 * GB, headroom: HEADROOM })
    const store = useDownloadStore.getState()
    store.addLocalDownloadingModel('big-q4_k_m')
    store.setDownloadOrigin('big-q4_k_m', 'acme/Big-GGUF')

    const result = await service.pullModelWithMetadata(
      'big-q4_k_m',
      BIG_PATH,
      BIG_MMPROJ_PATH,
      undefined,
      true,
      false
    )

    expect(result).toEqual({
      kind: 'disk_full',
      needed: 6 * GB + 800 * MB + HEADROOM,
      available: 2 * GB,
    })
    // Nothing started.
    expect(engine.import).not.toHaveBeenCalled()
    const after = useDownloadStore.getState()
    expect(after.downloads['big-q4_k_m']).toBeUndefined()
    expect(after.localDownloadingModels.has('big-q4_k_m')).toBe(false)
    expect(after.downloadOriginByModelId['big-q4_k_m']).toBeUndefined()
    expect(
      after.downloadRequestOriginByModelId['big-q4_k_m']
    ).toBeUndefined()
    expect(after.resumeParams['big-q4_k_m']).toBeUndefined()
    // One plain-language toast, not the download-failed one.
    expect(mockToast.error).toHaveBeenCalledTimes(1)
    const [title, options] = mockToast.error.mock.calls[0]
    expect(title).toBe("This model won't fit on your disk")
    expect(options.description).toBe(
      'big-q4_k_m needs 7.3 GB free and this drive has 2.0 GB. Pick a smaller model or free up space.'
    )
    // Not a failed download: no error event, no "started" funnel entry.
    expect(mockEvents.emit).not.toHaveBeenCalledWith(
      'onFileDownloadError',
      expect.anything()
    )
    expect(mockQueuedCapture).not.toHaveBeenCalledWith(
      'model_download',
      expect.objectContaining({ download_status: 'started' })
    )
  })

  it('starts a model that fits', async () => {
    mockFreeSpace({ available: 20 * GB, headroom: HEADROOM })
    useDownloadStore.getState().addLocalDownloadingModel('small-q4_k_m')

    const result = await service.pullModelWithMetadata(
      'small-q4_k_m',
      SMALL_PATH,
      undefined,
      'hf_token',
      true,
      false
    )

    expect(result).toBeUndefined()
    expect(mockToast.error).not.toHaveBeenCalled()
    expect(engine.import).toHaveBeenCalledWith(
      'small-q4_k_m',
      expect.objectContaining({ modelPath: SMALL_PATH, resume: false })
    )
    const after = useDownloadStore.getState()
    expect(after.localDownloadingModels.has('small-q4_k_m')).toBe(true)
    expect(after.resumeParams['small-q4_k_m']).toMatchObject({
      modelPath: SMALL_PATH,
      hfToken: 'hf_token',
    })
  })

  it('starts when free space is unknown to the OS', async () => {
    mockFreeSpace({ available: null, headroom: HEADROOM })

    await service.pullModelWithMetadata(
      'big-q4_k_m',
      BIG_PATH,
      undefined,
      undefined,
      true,
      false
    )

    expect(engine.import).toHaveBeenCalledTimes(1)
    expect(mockToast.error).not.toHaveBeenCalled()
    expect(
      useDownloadStore.getState().resumeParams['big-q4_k_m']
    ).toMatchObject({ modelPath: BIG_PATH })
  })

  it('starts when the free-space command itself fails', async () => {
    mockFreeSpace(() => {
      throw new Error('command not found')
    })

    await service.pullModelWithMetadata(
      'big-q4_k_m',
      BIG_PATH,
      undefined,
      undefined,
      true,
      false
    )

    expect(engine.import).toHaveBeenCalledTimes(1)
    expect(mockToast.error).not.toHaveBeenCalled()
    expect(
      useDownloadStore.getState().resumeParams['big-q4_k_m']
    ).toMatchObject({ modelPath: BIG_PATH })
  })

  it('rejects a file without metadata before checking space or importing it', async () => {
    const ipc = mockFreeSpace({ available: 1 * MB, headroom: HEADROOM })
    await expect(service.pullModelWithMetadata('else-q4_k_m', UNKNOWN_PATH)).rejects.toThrow('Missing file')
    expect(engine.import).not.toHaveBeenCalled()
    expect(ipc).not.toHaveBeenCalled()
    expect(useDownloadStore.getState().resumeParams['else-q4_k_m']).toBeUndefined()
  })

  it('does not second-guess a resume, whose partial is already on disk', async () => {
    mockFreeSpace({ available: 20 * GB, headroom: HEADROOM })
    await service.pullModelWithMetadata('big-q4_k_m', BIG_PATH)
    service = new DefaultModelsService()
    vi.mocked(fetch).mockRejectedValue(new Error('offline'))
    mockFreeSpace({ available: 1 * GB, headroom: HEADROOM })

    await service.pullModelWithMetadata(
      'big-q4_k_m',
      BIG_PATH,
      undefined,
      undefined,
      true,
      true
    )

    expect(engine.import).toHaveBeenCalledWith(
      'big-q4_k_m',
      expect.objectContaining({ resume: true })
    )
    expect(mockToast.error).not.toHaveBeenCalled()
    expect(
      useDownloadStore.getState().resumeParams['big-q4_k_m']
    ).toMatchObject({ modelPath: BIG_PATH })
  })

  describe('on the destination volume', () => {
    type Volume = {
      free_bytes: number
      total_bytes: number
      fs_name: string | null
      volume_root: string | null
    }
    const mockVolume = (volume: Volume) => {
      const ipc = vi.fn((command: string, args?: unknown) => {
        if (command === 'get_disk_space_info') return volume
        if (command === 'get_download_free_space')
          return { available: 1000 * GB, headroom: HEADROOM }
        return args === undefined ? undefined : undefined
      })
      mockIPC(ipc)
      return ipc
    }

    it('names the drive and offers another folder when the model will not fit', async () => {
      const ipc = mockVolume({
        free_bytes: 2 * GB,
        total_bytes: 256 * GB,
        fs_name: 'NTFS',
        volume_root: 'D:\\',
      })

      const result = await service.pullModelWithMetadata(
        'big-q4_k_m',
        BIG_PATH,
        BIG_MMPROJ_PATH,
        undefined,
        true,
        false
      )

      expect(ipc).toHaveBeenCalledWith('get_disk_space_info', { path: '.' })
      // What is left to write plus max(512 MiB, 2% of the download).
      expect(result).toEqual({
        kind: 'disk_full',
        needed: 6 * GB + 800 * MB + HEADROOM,
        available: 2 * GB,
        volume: 'D:\\',
      })
      expect(engine.import).not.toHaveBeenCalled()
      const [, options] = mockToast.error.mock.calls[0]
      expect(options.description).toBe(
        'big-q4_k_m needs 7.3 GB free and D:\\ has 2.0 GB. Pick a smaller model, free up space, or move the data folder to another drive.'
      )
      expect(options.action.label).toBe('Change data folder')
    })

    it('refuses a file of 4 GiB or more on a FAT32 drive, whatever its free space', async () => {
      mockVolume({
        free_bytes: 500 * GB,
        total_bytes: 1000 * GB,
        fs_name: 'FAT32',
        volume_root: 'E:\\',
      })

      const result = await service.pullModelWithMetadata(
        'big-q4_k_m',
        BIG_PATH,
        undefined,
        undefined,
        true,
        false
      )

      expect(result).toEqual({
        kind: 'fs_file_limit',
        fileBytes: 6 * GB,
        fsName: 'FAT32',
        volume: 'E:\\',
      })
      expect(engine.import).not.toHaveBeenCalled()
      const [title] = mockToast.error.mock.calls[0]
      expect(title).toBe("This drive can't store files over 4 GB")
    })

    it('starts a file under 4 GiB on FAT32, and anything on exFAT', async () => {
      mockVolume({
        free_bytes: 500 * GB,
        total_bytes: 1000 * GB,
        fs_name: 'FAT32',
        volume_root: 'E:\\',
      })
      await expect(
        service.pullModelWithMetadata(
          'small-q4_k_m',
          SMALL_PATH,
          undefined,
          undefined,
          true,
          false
        )
      ).resolves.toBeUndefined()

      mockVolume({
        free_bytes: 500 * GB,
        total_bytes: 1000 * GB,
        fs_name: 'exFAT',
        volume_root: 'E:\\',
      })
      await expect(
        service.pullModelWithMetadata(
          'big-q4_k_m',
          BIG_PATH,
          undefined,
          undefined,
          true,
          false
        )
      ).resolves.toBeUndefined()
      expect(mockToast.error).not.toHaveBeenCalled()
    })

    it('counts what a resume has already downloaded', async () => {
      mockFreeSpace({ available: 20 * GB, headroom: HEADROOM })
      await service.pullModelWithMetadata('big-q4_k_m', BIG_PATH)
      service = new DefaultModelsService()
      vi.mocked(fetch).mockRejectedValue(new Error('offline'))
      useDownloadStore
        .getState()
        .updateProgress('big-q4_k_m', 0.9, 'big-q4_k_m', 5.5 * GB, 6 * GB)
      // 0.5 GB still to write + 512 MiB headroom fits in 1.1 GB.
      mockVolume({
        free_bytes: 1.1 * GB,
        total_bytes: 256 * GB,
        fs_name: 'NTFS',
        volume_root: 'C:\\',
      })

      await expect(
        service.pullModelWithMetadata(
          'big-q4_k_m',
          BIG_PATH,
          undefined,
          undefined,
          true,
          true
        )
      ).resolves.toBeUndefined()
      expect(engine.import).toHaveBeenLastCalledWith(
        'big-q4_k_m',
        expect.objectContaining({ resume: true })
      )
    })
  })
})

describe("the downloader's own rules", () => {
  it('keeps 2% of the download free, at least 512 MiB, like disk.rs', () => {
    expect(downloadHeadroomBytes(6 * GB)).toBe(HEADROOM)
    expect(downloadHeadroomBytes(50 * GB)).toBe(Math.floor((50 * GB) / 100) * 2)
  })

  it('treats FAT12/16/32 as FAT, and exFAT or NTFS not', () => {
    for (const fat of ['FAT', 'FAT16', 'FAT32', 'fat32', 'vfat', 'msdos'])
      expect(isFatFileSystem(fat)).toBe(true)
    for (const other of ['exFAT', 'NTFS', 'apfs', null])
      expect(isFatFileSystem(other)).toBe(false)
  })
})

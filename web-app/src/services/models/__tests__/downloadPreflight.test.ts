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

vi.mock('@janhq/core', () => ({
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

const GB = 1024 ** 3
const MB = 1024 ** 2
const HEADROOM = 512 * MB

const BIG_PATH =
  'https://huggingface.co/acme/Big-GGUF/resolve/main/big-q4_k_m.gguf'
const BIG_MMPROJ_PATH =
  'https://huggingface.co/acme/Big-GGUF/resolve/main/mmproj-f16.gguf'
const SMALL_PATH =
  'https://huggingface.co/acme/Small-GGUF/resolve/main/small-q4_k_m.gguf'
const UNKNOWN_PATH =
  'https://huggingface.co/someone/Else-GGUF/resolve/main/else-q4_k_m.gguf'

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

  it('starts when the size is not known up front', async () => {
    // Not in the catalog and no HF metadata fetched: the Rust preflight
    // (which measures the real size) is the guard.
    const ipc = mockFreeSpace({ available: 1 * MB, headroom: HEADROOM })

    await service.pullModelWithMetadata(
      'else-q4_k_m',
      UNKNOWN_PATH,
      undefined,
      undefined,
      true,
      false
    )

    expect(engine.import).toHaveBeenCalledTimes(1)
    expect(ipc).not.toHaveBeenCalledWith('get_download_free_space', undefined)
    expect(mockToast.error).not.toHaveBeenCalled()
    expect(
      useDownloadStore.getState().resumeParams['else-q4_k_m']
    ).toMatchObject({ modelPath: UNKNOWN_PATH })
  })

  it('does not second-guess a resume, whose partial is already on disk', async () => {
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
})

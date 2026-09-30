import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ATO-530: the stage an MLX load reports while the user waits, and a Cancel
// that leaves no server behind. Mocks mirror `autoIncreaseCtx.test.ts`.

const { invokeMock, loadMlxModelMock, unloadMlxModelMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  loadMlxModelMock: vi.fn(),
  unloadMlxModelMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(() => {}),
}))

vi.mock('@tauri-apps/plugin-log', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: vi.fn(),
}))

vi.mock('@janhq/tauri-plugin-mlx-api', () => ({
  loadMlxModel: loadMlxModelMock,
  unloadMlxModel: unloadMlxModelMock,
}))

vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  readGgufMetadata: vi.fn(),
}))

vi.mock('@janhq/core', () => ({
  AIEngine: class AIEngine {
    registerSettings(_: unknown) {}
    getSetting<T>(_: string, def: T) {
      return Promise.resolve(def)
    }
    async getSettings() {
      return []
    }
    async updateSettings(_: unknown) {}
    onLoad() {}
  },
  getJanDataFolderPath: vi.fn().mockResolvedValue('/tmp/jan'),
  fs: {
    existsSync: vi.fn().mockResolvedValue(false),
    readdirSync: vi.fn(),
    fileStat: vi.fn().mockRejectedValue(new Error('not stubbed')),
    mkdir: vi.fn(),
    rm: vi.fn(),
  },
  joinPath: vi.fn((parts: string[]) => Promise.resolve(parts.join('/'))),
  events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
  AppEvent: { onModelImported: 'onModelImported' },
  DownloadEvent: { onFileDownloadStopped: 'onFileDownloadStopped' },
  ModelEvent: { OnAutoIncreasedCtxLen: 'OnAutoIncreasedCtxLen' },
  DEFAULT_CTX_LEN: 16384,
  computeNextCtxLen: (current: number) => current * 2,
}))

import mlx_extension from './index'

const session = { pid: 42, port: 7777, api_key: '', model_id: 'm' }

describe('mlx_extension load stages and cancel', () => {
  let ext: mlx_extension
  let cancelReplies: Array<() => boolean>

  beforeEach(() => {
    vi.clearAllMocks()
    cancelReplies = []
    ext = new mlx_extension()
    ;(ext as unknown as { config: Record<string, unknown> }).config = {
      ctx_size: 4096,
    }
    ;(ext as unknown as { providerPath: string }).providerPath = '/tmp/jan/mlx'
    invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case 'plugin:mlx|find_mlx_session_by_model':
          return null
        case 'plugin:mlx|get_mlx_loaded_models':
          return []
        case 'plugin:mlx|get_mlx_random_port':
          return 7777
        case 'read_yaml':
          // A legacy entry that points at the first weight file.
          return { model_path: 'mlx/models/m/model.safetensors' }
        case 'get_page_cache_resident_fraction':
          return 0.4
        case 'plugin:mlx|cancel_mlx_model_load':
          return cancelReplies.shift()?.() ?? false
        default:
          return undefined
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports the weights stage for the model folder', async () => {
    loadMlxModelMock.mockResolvedValue(session)
    const onStage = vi.fn()

    await expect(
      ext.load('m', undefined, false, false, { onStage })
    ).resolves.toEqual(session)

    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual([
      { kind: 'loadingWeights', cachedFraction: 0.4 },
    ])
    const probed = invokeMock.mock.calls.find(
      ([command]) => command === 'get_page_cache_resident_fraction'
    )
    expect(probed?.[1]).toEqual({ paths: ['/tmp/jan/mlx/models/m'] })
  })

  it('cancels a load inside the plugin, retrying until the plugin has it', async () => {
    let rejectLoad: (error: unknown) => void = () => {}
    loadMlxModelMock.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectLoad = reject
        })
    )
    cancelReplies = [
      () => false,
      () => {
        rejectLoad({ code: 'MODEL_LOAD_CANCELLED', message: 'cancelled' })
        return true
      },
    ]

    const load = ext.load('m')
    const outcome = expect(load).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
    })
    await vi.waitFor(() => expect(loadMlxModelMock).toHaveBeenCalled())

    await expect(ext.cancelLoad('m')).resolves.toBe(true)
    await outcome
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === 'plugin:mlx|cancel_mlx_model_load'
      )
    ).toHaveLength(2)
  })

  it('takes down a server that came up before the cancel reached it', async () => {
    let resolveLoad: (value: unknown) => void = () => {}
    loadMlxModelMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        })
    )
    unloadMlxModelMock.mockResolvedValue({ success: true })
    cancelReplies = [
      () => {
        resolveLoad(session)
        return false
      },
    ]

    const load = ext.load('m')
    const outcome = expect(load).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
    })
    await vi.waitFor(() => expect(loadMlxModelMock).toHaveBeenCalled())
    await ext.cancelLoad('m')

    await outcome
    expect(unloadMlxModelMock).toHaveBeenCalledWith(42)
  })

  it('has nothing to cancel when no load of the model is running', async () => {
    await expect(ext.cancelLoad('m')).resolves.toBe(false)
  })
})

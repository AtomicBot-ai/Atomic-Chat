import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ATO-530: the stage an MLX load reports while the user waits, and a Cancel that leaves no
// server behind. The load itself runs in `atomic-chat-core`, so the cancel is a control call
// too; the shared protocol lives in `extensions/shared/loadCancel.ts` and is exercised here
// through the extension's own `load`/`cancelLoad`. Mocks mirror `coreOwned.test.ts`.

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

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
import { LoadCancelTracker } from '../../shared/loadCancel'

const session = {
  pid: 42,
  port: 7777,
  model_id: 'm',
  model_path: '/tmp/jan/mlx/models/m',
  is_embedding: false,
  api_key: '',
}

type Route = (body: unknown) => unknown

describe('mlx_extension load stages and cancel', () => {
  let ext: mlx_extension
  let routes: Record<string, Route>
  let calls: string[]

  beforeEach(() => {
    vi.clearAllMocks()
    calls = []
    routes = {
      'GET /sessions': () => ({ sessions: [] }),
      'POST /settings/mlx/import': () => ({
        status: 'imported',
        applied: [],
        conflicts: [],
        revision: 1,
      }),
      'GET /settings/mlx': () => ({ provider: 'mlx', revision: 2, values: {} }),
      'POST /settings/mlx/acknowledge': () => ({}),
      'POST /models/mlx/m/load/cancel': () => ({ cancelled: false }),
      'POST /models/mlx/m/unload': () => ({ success: true }),
    }
    ext = new mlx_extension()
    ;(ext as unknown as { config: Record<string, unknown> }).config = {
      ctx_size: 4096,
    }
    ;(ext as unknown as { providerPath: string }).providerPath = '/tmp/jan/mlx'
    ;(
      ext as unknown as { resolveModelMaxCtxTrain: () => Promise<number> }
    ).resolveModelMaxCtxTrain = async () => 32768
    // No wait between cancel retries: the test controls when the load answers.
    ;(ext as unknown as { loadCancel: LoadCancelTracker }).loadCancel =
      new LoadCancelTracker(
        (ext as unknown as { core: ConstructorParameters<typeof LoadCancelTracker>[0] })
          .core,
        () => {},
        0
      )
    invokeMock.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        switch (command) {
          case 'atomic_core_status':
            return { running: true, attached: { instance_id: 'i', generation: 1 } }
          case 'read_yaml':
            // A legacy entry that points at the first weight file.
            return { model_path: 'mlx/models/m/model.safetensors' }
          case 'get_page_cache_resident_fraction':
            return 0.4
          case 'atomic_core_call': {
            const key = `${String(args?.['method'])} ${String(args?.['path'])}`
            calls.push(key)
            const route = routes[key]
            if (!route) throw new Error(`unrouted ${key}`)
            return route(args?.['body'])
          }
          default:
            throw new Error(`plugin reached: ${command}`)
        }
      }
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports the weights stage for the model folder before asking the core', async () => {
    routes['POST /models/mlx/m/load'] = () => ({ session, created: true })
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
    const invoked = invokeMock.mock.calls.map(([command, args]) =>
      command === 'atomic_core_call'
        ? `${String(args?.['method'])} ${String(args?.['path'])}`
        : command
    )
    expect(invoked.indexOf('get_page_cache_resident_fraction')).toBeLessThan(
      invoked.indexOf('POST /models/mlx/m/load')
    )
    expect(calls.at(-1)).toBe('POST /models/mlx/m/load')
  })

  it('loads without a stage when the caller asks for none', async () => {
    routes['POST /models/mlx/m/load'] = () => ({ session, created: true })
    await expect(ext.load('m')).resolves.toEqual(session)
    expect(
      invokeMock.mock.calls.some(([c]) => c === 'get_page_cache_resident_fraction')
    ).toBe(false)
  })

  it('cancels a load inside the core, retrying until the core has it', async () => {
    let rejectLoad: (error: unknown) => void = () => {}
    routes['POST /models/mlx/m/load'] = () =>
      new Promise((_, reject) => {
        rejectLoad = reject
      })
    const cancelReplies = [
      () => false,
      () => {
        rejectLoad({ code: 'MODEL_LOAD_CANCELLED', message: 'The model load was cancelled.' })
        return true
      },
    ]
    routes['POST /models/mlx/m/load/cancel'] = () => ({
      cancelled: cancelReplies.shift()?.() ?? false,
    })

    const load = ext.load('m')
    const outcome = expect(load).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
      message: 'The model load was cancelled. [MODEL_LOAD_CANCELLED]',
    })
    await vi.waitFor(() =>
      expect(calls).toContain('POST /models/mlx/m/load')
    )

    await expect(ext.cancelLoad('m')).resolves.toBe(true)
    await outcome
    expect(calls.filter((c) => c === 'POST /models/mlx/m/load/cancel')).toHaveLength(2)
    expect(calls).not.toContain('POST /models/mlx/m/unload')
  })

  it('takes down a session that came up before the cancel reached the core', async () => {
    let resolveLoad: (value: unknown) => void = () => {}
    routes['POST /models/mlx/m/load'] = () =>
      new Promise((resolve) => {
        resolveLoad = resolve
      })
    routes['POST /models/mlx/m/load/cancel'] = () => {
      resolveLoad({ session, created: true })
      return { cancelled: false }
    }

    const load = ext.load('m')
    const outcome = expect(load).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
    })
    await vi.waitFor(() =>
      expect(calls).toContain('POST /models/mlx/m/load')
    )
    await expect(ext.cancelLoad('m')).resolves.toBe(true)

    await outcome
    expect(calls.at(-1)).toBe('POST /models/mlx/m/unload')
    expect(await ext.getLoadedModels()).toEqual([])
  })

  it('stops a load cancelled before it reached the core, without asking the core', async () => {
    routes['POST /models/mlx/m/load'] = () => ({ session, created: true })
    // The settings handover is the last step before the core load: cancel while it is running.
    let cancelled: Promise<boolean> | undefined
    routes['GET /settings/mlx'] = () => {
      cancelled = ext.cancelLoad('m')
      return { provider: 'mlx', revision: 2, values: {} }
    }

    await expect(ext.load('m')).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
    })
    await expect(cancelled).resolves.toBe(true)
    expect(calls).not.toContain('POST /models/mlx/m/load')
    expect(calls).not.toContain('POST /models/mlx/m/load/cancel')
  })

  it('keeps the code of a load the core refused', async () => {
    routes['POST /models/mlx/m/load'] = () =>
      Promise.reject({
        code: 'MODEL_FILE_NOT_FOUND',
        message: 'Model file not found.',
        details: '/tmp/jan/mlx/models/m',
      })
    await expect(ext.load('m')).rejects.toMatchObject({
      code: 'MODEL_FILE_NOT_FOUND',
      message: 'Model file not found. (/tmp/jan/mlx/models/m) [MODEL_FILE_NOT_FOUND]',
    })
  })

  it('has nothing to cancel when no load of the model is running', async () => {
    await expect(ext.cancelLoad('m')).resolves.toBe(false)
  })
})

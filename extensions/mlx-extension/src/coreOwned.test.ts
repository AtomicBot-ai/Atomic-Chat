import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The MLX runtime handed to `atomic-chat-core` (`atomic_core.runtime = all`, PLAN.md stage 5).
// Mocks as in `autoIncreaseCtx.test.ts`. See
// that file for the rationale behind the inline mocks. The MLX handler has
// the same contract as llamacpp — same event channels, same
// `computeNextCtxLen` ladder, same done-event payload — so we reuse the
// same assertions against the MLX class.

const { emitMock, listenMock, eventsEmitMock, invokeMock, listeners } =
  vi.hoisted(() => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>()
    return {
      emitMock: vi.fn().mockResolvedValue(undefined),
      listenMock: vi.fn(
        async (
          name: string,
          handler: (event: { payload: unknown }) => void
        ) => {
          listeners.set(name, handler)
          return () => listeners.delete(name)
        }
      ),
      eventsEmitMock: vi.fn(),
      invokeMock: vi.fn(),
      listeners,
    }
  })

vi.mock('@tauri-apps/api/event', () => ({
  emit: emitMock,
  listen: listenMock,
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
  loadMlxModel: vi.fn(),
  unloadMlxModel: vi.fn(),
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
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    fileStat: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
  },
  joinPath: vi.fn((parts: string[]) => Promise.resolve(parts.join('/'))),
  events: {
    emit: eventsEmitMock,
    on: vi.fn(),
    off: vi.fn(),
  },
  AppEvent: { onModelImported: 'onModelImported' },
  DownloadEvent: {
    onFileDownloadStopped: 'onFileDownloadStopped',
  },
  ModelEvent: {
    OnAutoIncreasedCtxLen: 'OnAutoIncreasedCtxLen',
  },
  // Read at module load by `buildMlxConfig` / the ctx fallbacks, so a
  // factory mock without it throws before any test runs.
  DEFAULT_CTX_LEN: 16384,
  computeNextCtxLen: (current: number, max?: number) => {
    let next: number
    if (current < 8192) next = 8192
    else if (current < 32768) next = 32768
    else next = Math.round(current * 1.5)
    if (typeof max === 'number' && max > 0) next = Math.min(next, max)
    return next
  },
}))

import mlx_extension from './index'
import { loadMlxModel, unloadMlxModel } from '@janhq/tauri-plugin-mlx-api'

type Route = (body: unknown) => unknown
function core(routes: Record<string, Route>, runtime: string | null = 'all') {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  invokeMock.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === 'atomic_core_begin_runtime_load') return 7
      if (command === 'atomic_core_end_runtime_load') return undefined
      if (command === 'atomic_core_status')
        return {
          active_runtime: runtime,
          attached: { instance_id: 'i', generation: 1 },
        }
      if (command === 'read_yaml')
        return { model_path: 'mlx/models/m/model.safetensors' }
      if (command === 'atomic_core_call') {
        const call = {
          method: String(args?.['method']),
          path: String(args?.['path']),
          body: args?.['body'],
        }
        calls.push(call)
        const route = routes[`${call.method} ${call.path}`]
        if (!route) throw new Error(`unrouted ${call.method} ${call.path}`)
        return route(call.body)
      }
      throw new Error(`plugin reached: ${command}`)
    }
  )
  return calls
}

const session = {
  pid: 7,
  port: 3100,
  model_id: 'm',
  model_path: '/data/mlx/models/m',
  is_embedding: false,
  api_key: '',
}
const handover = {
  'POST /settings/mlx/import': () => ({
    status: 'imported',
    applied: [],
    conflicts: [],
    revision: 1,
  }),
  'GET /settings/mlx': () => ({ provider: 'mlx', revision: 2, values: {} }),
  'POST /settings/mlx/acknowledge': () => ({}),
}

function extension(config: Record<string, unknown> = {}) {
  const ext = new mlx_extension()
  ;(ext as unknown as { config: Record<string, unknown> }).config = {
    auto_unload: true,
    ...config,
  }
  ext.autoUnload = config['auto_unload'] !== false
  ;(ext as unknown as { providerPath: string }).providerPath = '/data/mlx'
  ;(
    ext as unknown as { resolveModelMaxCtxTrain: () => Promise<number> }
  ).resolveModelMaxCtxTrain = async () => 32768
  return ext
}

beforeEach(() => {
  vi.clearAllMocks()
  listeners.clear()
})

describe('MLX runtime owned by the core', () => {
  it('evicts through the core, restores the drafter here, and loads with the resolved settings', async () => {
    let sessions: unknown[] = [
      { ...session, model_id: 'other', provider: 'mlx' },
    ]
    const calls = core({
      'GET /sessions': () => ({ sessions }),
      'POST /models/mlx/other/unload': () => {
        sessions = []
        return { success: true }
      },
      ...handover,
      'POST /models/mlx/m/load': () => ({ session, created: true }),
    })
    const ext = extension({
      mtp_enabled: true,
      kv_quant_scheme: 'turboquant',
      kv_bits: 3.5,
    })
    ;(
      ext as unknown as { ensureDraftDownloaded: () => Promise<string> }
    ).ensureDraftDownloaded = async () => '/data/mlx/draft-models/owner/drafter'
    // A model the MTP registry knows, so the cold-start restore runs.
    vi.spyOn(await import('./mtpRegistry'), 'resolveMtpDraft').mockReturnValue({
      repo: 'owner/drafter',
      required: ['config.json'],
      optional: [],
    } as never)

    expect(await ext.load('m', { ctx_size: 8192 })).toEqual(session)
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === 'atomic_core_begin_runtime_load'
      )
    ).toEqual([['atomic_core_begin_runtime_load', { provider: 'mlx' }]])
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === 'atomic_core_end_runtime_load'
      )
    ).toEqual([['atomic_core_end_runtime_load', { id: 7 }]])
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /sessions',
      'GET /sessions',
      'GET /sessions',
      'GET /sessions',
      'POST /models/mlx/other/unload',
      'POST /settings/mlx/import',
      'GET /settings/mlx',
      'POST /settings/mlx/acknowledge',
      'POST /models/mlx/m/load',
    ])
    expect(calls.at(-1)?.body).toEqual({
      overrides: expect.objectContaining({
        ctx_size: 8192,
        mtp_enabled: true,
        kv_bits: 3.5,
        draft_model_path: '/data/mlx/draft-models/owner/drafter',
      }),
      isEmbedding: false,
      bypassAutoUnload: true,
    })
    expect(loadMlxModel).not.toHaveBeenCalled()
  })

  it('reports a failed core load with its code and refuses a model already loaded', async () => {
    core({
      'GET /sessions': () => ({ sessions: [] }),
      ...handover,
      'POST /models/mlx/m/load': () =>
        Promise.reject({ code: 'OUT_OF_MEMORY', message: 'Out of memory.' }),
    })
    await expect(extension({ auto_unload: false }).load('m')).rejects.toThrow(
      'Out of memory. [OUT_OF_MEMORY]'
    )
    core({
      'GET /sessions': () => ({ sessions: [{ ...session, provider: 'mlx' }] }),
    })
    await expect(extension().load('m')).rejects.toThrow('Model already loaded!')
  })

  it('unloads and lists in the core, keeping the extension wording for a missing session', async () => {
    let unloadAnswer: Route = () => ({ success: true })
    core({
      'GET /sessions': () => ({ sessions: [{ ...session, provider: 'mlx' }] }),
      'POST /models/mlx/m/unload': (body) => unloadAnswer(body),
    })
    const ext = extension()
    expect(await ext.getLoadedModels()).toEqual(['m'])
    expect(await ext.unload('m')).toEqual({ success: true })
    unloadAnswer = () =>
      Promise.reject({ code: 'CORE_NOT_RUNNING', message: 'stopping' })
    expect(await ext.unload('m')).toEqual({
      success: false,
      error: 'Failed to unload model: stopping [CORE_NOT_RUNNING]',
    })
    await expect(ext.unload('nope')).rejects.toThrow(
      'No active MLX session found for model: nope'
    )
    expect(unloadMlxModel).not.toHaveBeenCalled()
  })

  it('chats with a core session without asking the plugin whether the process runs', async () => {
    core({
      'GET /sessions': () => ({ sessions: [{ ...session, provider: 'mlx' }] }),
    })
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/health')
        ? new Response('{}')
        : new Response(
            JSON.stringify({
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            })
          )
    )
    vi.stubGlobal('fetch', fetchMock)
    const answer = await extension().chat({ model: 'm', messages: [] } as never)
    expect(answer).toMatchObject({ choices: [{ message: { content: 'ok' } }] })
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain(
      'http://localhost:3100/v1/chat/completions'
    )
    vi.unstubAllGlobals()
  })

  it('asks the core to grow the context and relays both outcomes', async () => {
    let outcome: unknown = { ok: true, new_ctx_len: 32768 }
    core({ 'POST /models/mlx/m/ctx/increase': () => outcome })
    const ext = extension()
    const handle = (id: string) =>
      (
        ext as unknown as {
          handleAutoIncreaseCtx: (p: unknown) => Promise<void>
        }
      ).handleAutoIncreaseCtx({
        request_id: id,
        backend: 'mlx',
        model_id: 'm',
        trigger: 'error',
      })
    await handle('a')
    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_done/a',
      { ok: true, new_ctx_len: 32768 }
    )
    expect(eventsEmitMock).toHaveBeenCalledWith('OnAutoIncreasedCtxLen', {
      provider: 'mlx',
      modelId: 'm',
      newCtxLen: 32768,
    })
    outcome = { ok: false, reason: 'at_max', current_ctx_len: 32768 }
    await handle('b')
    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_done/b',
      { ok: false, reason: 'at_max' }
    )
    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_at_max',
      {
        provider: 'mlx',
        modelId: 'm',
        maxCtxLen: 32768,
        currentCtxLen: 32768,
      }
    )
  })

  it('mirrors changed core settings without restarting a live session', async () => {
    const calls = core({
      'GET /settings/mlx': () => ({
        provider: 'mlx',
        revision: 5,
        values: { block_size: 8 },
      }),
      'POST /settings/mlx/acknowledge': () => ({}),
    })
    const ext = extension({ dflash_enabled: true })
    ;(ext as unknown as { getSettings: () => Promise<unknown[]> }).getSettings =
      async () => [{ key: 'block_size', controllerProps: { value: 16 } }]
    ;(
      ext as unknown as {
        updateSettings: (
          s: Array<{ key: string; controllerProps: { value: unknown } }>
        ) => Promise<void>
      }
    ).updateSettings = async (settings) => {
      for (const setting of settings)
        ext.onSettingUpdate(setting.key, setting.controllerProps.value)
    }
    const reload = vi.fn()
    ;(ext as unknown as { scheduleBlockReload: unknown }).scheduleBlockReload =
      reload
    await (
      ext as unknown as { listenForCoreSettings: () => Promise<void> }
    ).listenForCoreSettings()
    listeners.get('atomic-core://settings:changed')?.({
      payload: { provider: 'llamacpp' },
    })
    listeners.get('atomic-core://settings:changed')?.({
      payload: { provider: 'mlx' },
    })
    await vi.waitFor(() =>
      expect(calls.map((c) => c.path)).toEqual([
        '/settings/mlx',
        '/settings/mlx/acknowledge',
      ])
    )
    expect(
      (ext as unknown as { config: Record<string, unknown> }).config[
        'block_size'
      ]
    ).toBe(8)
    expect(reload).not.toHaveBeenCalled()
    await ext.onUnload()
    expect(listeners.has('atomic-core://settings:changed')).toBe(false)
  })
})

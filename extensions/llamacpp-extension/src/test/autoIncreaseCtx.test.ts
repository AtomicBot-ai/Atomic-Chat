import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// This test file is self-contained: it stubs `@janhq/core` and Tauri
// primitives locally so the handler logic can be exercised without the
// heavy existing setup that runs the whole extension. It focuses on the
// `handleAutoIncreaseCtx` contract:
//   1. the core is asked to grow the context (or to restart a poisoned
//      engine) — the extension never unloads or loads the model itself
//   2. a Tauri `auto_increase_ctx_done/{request_id}` event relays the outcome
//   3. the UI is told about a new window, or that the model is at its maximum

const { emitMock, listenMock, eventsEmitMock } = vi.hoisted(() => ({
  emitMock: vi.fn().mockResolvedValue(undefined),
  listenMock: vi.fn().mockResolvedValue(() => {}),
  eventsEmitMock: vi.fn(),
}))

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
  invoke: vi.fn(),
  Channel: vi.fn(),
}))

vi.mock('@tauri-apps/api/path', () => ({
  basename: vi.fn(),
}))

vi.mock('@janhq/tauri-plugin-hardware-api', () => ({
  getSystemInfo: vi.fn(),
  getSystemUsage: vi.fn(),
}))

vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  readGgufMetadata: vi.fn(),
  isModelSupported: vi.fn(),
  mapOldBackendToNew: vi.fn(),
  findLatestVersionForBackend: vi.fn(),
  prioritizeBackends: vi.fn(),
  removeOldBackendVersions: vi.fn(),
  shouldMigrateBackend: vi.fn(),
  handleSettingUpdate: vi.fn(),
  installBundledBackend: vi.fn(),
  checkBackendForUpdates: vi.fn(),
}))

vi.mock('../backend', () => ({
  listSupportedBackends: vi.fn(),
  isBackendInstalled: vi.fn(),
  getBackendDir: vi.fn(),
  getLocalInstalledBackends: vi.fn(),
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
    onModelValidationStarted: 'onModelValidationStarted',
  },
  ModelEvent: {
    OnAutoIncreasedCtxLen: 'OnAutoIncreasedCtxLen',
  },
}))

import { invoke } from '@tauri-apps/api/core'
import llamacpp_extension from '../index'

type AutoIncreaseRequest = {
  request_id: string
  backend: 'llamacpp' | 'mlx'
  model_id: string
  trigger: 'error' | 'finish_length' | 'compute_error_recovery'
}

type CoreCall = { method: string; path: string; body: unknown }

/** Route `atomic_core_call` to per-test handlers; anything else is a plugin call and fails. */
function routeCore(routes: Record<string, (body: unknown) => unknown>) {
  const calls: CoreCall[] = []
  vi.mocked(invoke).mockImplementation((async (
    command: string,
    args?: Record<string, unknown>
  ) => {
    if (command !== 'atomic_core_call') throw new Error(`plugin reached: ${command}`)
    const call = {
      method: String(args?.['method']),
      path: String(args?.['path']),
      body: args?.['body'],
    }
    calls.push(call)
    const route = routes[`${call.method} ${call.path}`]
    if (!route) throw new Error(`unrouted ${call.method} ${call.path}`)
    return route(call.body)
  }) as never)
  return calls
}

describe('llamacpp_extension auto_increase_ctx handler', () => {
  let ext: llamacpp_extension

  beforeEach(() => {
    vi.clearAllMocks()
    // `restoreAllMocks` drops the resolved value between tests; the handler chains on the promise.
    emitMock.mockResolvedValue(undefined)
    ext = new llamacpp_extension()
    // Bypass the settings machinery that depends on AIEngine internals;
    // the handler only reads `config.fit` and `provider`.
    ;(ext as unknown as { config: Record<string, unknown> }).config = {
      ctx_size: 8192,
    }
  })

  afterEach(() => {
    vi.mocked(invoke).mockReset()
    vi.restoreAllMocks()
  })

  const invokeHandler = async (
    payload: AutoIncreaseRequest
  ): Promise<void> => {
    await (
      ext as unknown as {
        handleAutoIncreaseCtx: (p: AutoIncreaseRequest) => Promise<void>
      }
    ).handleAutoIncreaseCtx(payload)
  }

  it('does nothing while fit is on: the engine sizes the context itself', async () => {
    // `--ctx-size` is not emitted under fit, so a reload with a bigger value
    // would be sized straight back down — a reload that changes nothing.
    const calls = routeCore({})
    ;(ext as unknown as { config: Record<string, unknown> }).config = {
      ctx_size: 8192,
      fit: true,
    }

    await invokeHandler({
      request_id: 'req-fit',
      backend: 'llamacpp',
      model_id: 'm',
      trigger: 'error',
    })

    expect(calls).toEqual([])
    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_done/req-fit',
      { ok: false, reason: 'fit' }
    )
  })

  it('asks the core for one step, then relays the new window to the proxy and the UI', async () => {
    const unloadSpy = vi.spyOn(ext, 'unload')
    const loadSpy = vi.spyOn(ext, 'load')
    const calls = routeCore({
      'POST /models/llamacpp/org/m/ctx/increase': () => ({
        ok: true,
        new_ctx_len: 32768,
      }),
    })

    await invokeHandler({
      request_id: 'req-1',
      backend: 'llamacpp',
      model_id: 'org/m',
      trigger: 'finish_length',
    })

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/models/llamacpp/org/m/ctx/increase',
        body: { reason: 'finish_length' },
      },
    ])
    // The core owns the process: the extension never reloads it itself.
    expect(unloadSpy).not.toHaveBeenCalled()
    expect(loadSpy).not.toHaveBeenCalled()
    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_done/req-1',
      { ok: true, new_ctx_len: 32768 }
    )
    const notify = { provider: 'llamacpp', modelId: 'org/m', newCtxLen: 32768 }
    expect(eventsEmitMock).toHaveBeenCalledWith('OnAutoIncreasedCtxLen', notify)
    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_notify',
      notify
    )
    expect((ext as any).modelCtxSize.get('org/m')).toBe(32768)
  })

  it('relays at_max with the limits the core reports', async () => {
    routeCore({
      'POST /models/llamacpp/m/ctx/increase': () => ({
        ok: false,
        reason: 'at_max',
        current_ctx_len: 32768,
        max_ctx_len: 32768,
      }),
    })

    await invokeHandler({
      request_id: 'req-max',
      backend: 'llamacpp',
      model_id: 'm',
      trigger: 'error',
    })

    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_done/req-max',
      { ok: false, reason: 'at_max' }
    )
    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_at_max',
      {
        provider: 'llamacpp',
        modelId: 'm',
        maxCtxLen: 32768,
        currentCtxLen: 32768,
      }
    )
    expect(eventsEmitMock).not.toHaveBeenCalled()
  })

  it('falls back to the current window when the core does not know the maximum', async () => {
    routeCore({
      'POST /models/llamacpp/m/ctx/increase': () => ({
        ok: false,
        reason: 'at_max',
        current_ctx_len: 16384,
      }),
    })

    await invokeHandler({
      request_id: 'req-max2',
      backend: 'llamacpp',
      model_id: 'm',
      trigger: 'error',
    })

    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_at_max',
      expect.objectContaining({ maxCtxLen: 16384, currentCtxLen: 16384 })
    )
  })

  it('passes any other refusal through without an at_max broadcast', async () => {
    routeCore({
      'POST /models/llamacpp/m/ctx/increase': () => ({
        ok: false,
        reason: 'unsupported',
      }),
    })

    await invokeHandler({
      request_id: 'req-u',
      backend: 'llamacpp',
      model_id: 'm',
      trigger: 'error',
    })

    expect(emitMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_done/req-u',
      { ok: false, reason: 'unsupported' }
    )
  })

  it('emits done(ok:false, reason:exception:...) with the core error code when the call fails', async () => {
    routeCore({
      'POST /models/llamacpp/m/ctx/increase': () =>
        Promise.reject({ code: 'MODEL_LOAD_FAILED', message: 'OOM' }),
    })

    await invokeHandler({
      request_id: 'req-4',
      backend: 'llamacpp',
      model_id: 'm',
      trigger: 'error',
    })

    expect(emitMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_done/req-4',
      { ok: false, reason: 'exception: OOM [MODEL_LOAD_FAILED]' }
    )
  })

  it('restarts a poisoned engine through the core, even with fit on', async () => {
    ;(ext as unknown as { config: Record<string, unknown> }).config = {
      fit: true,
    }
    const calls = routeCore({
      'POST /models/llamacpp/m/recreate': () => ({ ok: true }),
    })

    await invokeHandler({
      request_id: 'req-r',
      backend: 'llamacpp',
      model_id: 'm',
      trigger: 'compute_error_recovery',
    })

    expect(calls.map((c) => c.path)).toEqual(['/models/llamacpp/m/recreate'])
    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_done/req-r',
      { ok: true }
    )
  })
})

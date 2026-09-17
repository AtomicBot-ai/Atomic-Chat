import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// This test file is self-contained: it stubs `@janhq/core` and Tauri
// primitives locally so the handler logic can be exercised without the
// heavy existing setup that runs the whole extension. It focuses on the
// `handleAutoIncreaseCtx` contract:
//   1. the core, which owns the process and the ladder, is asked to act —
//      the extension never unloads or reloads the model itself
//   2. a Tauri `auto_increase_ctx_done/{request_id}` event answers the proxy
//      with the outcome
//   3. the UI is told about a grown window, or that the model is at its max

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

vi.mock('../hardware', () => ({
  getSystemInfo: vi.fn(),
  getSystemUsage: vi.fn(),
}))

vi.mock(
  '../../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index',
  () => ({
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
  })
)

vi.mock('../backend', () => ({
  listSupportedBackends: vi.fn(),
  isBackendInstalled: vi.fn(),
  getBackendExePath: vi.fn(),
  getBackendDir: vi.fn(),
  getLocalInstalledBackends: vi.fn(),
  getBackendDownloadUrl: vi.fn(),
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

import llamacpp_extension from '../index'
import { invoke } from '@tauri-apps/api/core'

type AutoIncreaseRequest = {
  request_id: string
  backend: 'llamacpp' | 'llamacpp-upstream' | 'mlx'
  model_id: string
  trigger: 'error' | 'finish_length' | 'compute_error_recovery'
}

describe('llamacpp_extension auto_increase_ctx handler', () => {
  let ext: llamacpp_extension

  /** Answer the core's ctx route with `outcome`; every other call resolves empty. */
  const coreAnswers = (outcome: unknown) =>
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== 'atomic_core_call') return undefined
      const path = (args as { path: string }).path
      if (path.endsWith('/ctx/increase') || path.endsWith('/recreate')) {
        if (outcome instanceof Error) throw outcome
        return outcome
      }
      return undefined
    })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue(undefined)
    ext = new llamacpp_extension()
    // Bypass the settings machinery that depends on AIEngine internals;
    // the handler only cares about `config.fit`, `provider`, and the core.
    ;(ext as unknown as { config: Record<string, unknown> }).config = {
      ctx_size: 8192,
    }
  })

  afterEach(() => {
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
    const unloadSpy = vi.spyOn(ext, 'unload').mockResolvedValue({ success: true })
    const loadSpy = vi.spyOn(ext, 'load')
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

    expect(unloadSpy).not.toHaveBeenCalled()
    expect(loadSpy).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('atomic_core_call', expect.anything())
    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_done/req-fit',
      { ok: false, reason: 'fit' }
    )
  })

  it('asks the core to restart a poisoned engine instead of reloading it here', async () => {
    const unloadSpy = vi.spyOn(ext, 'unload')
    const loadSpy = vi.spyOn(ext, 'load')
    coreAnswers({ ok: true })

    await invokeHandler({
      request_id: 'req-compute',
      backend: 'llamacpp-upstream',
      model_id: 'm',
      trigger: 'compute_error_recovery',
    })

    expect(unloadSpy).not.toHaveBeenCalled()
    expect(loadSpy).not.toHaveBeenCalled()
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('atomic_core_call', {
      method: 'POST',
      path: '/models/llamacpp-upstream/m/recreate',
      body: null,
    })
    expect(emitMock).toHaveBeenCalledWith('local_backend://auto_increase_ctx_done/req-compute', { ok: true })
    // A recreate keeps the context, so the UI has nothing to mirror.
    expect(eventsEmitMock).not.toHaveBeenCalled()
  })

  it('passes the core refusal to recreate through to the proxy', async () => {
    coreAnswers({ ok: false, reason: 'not-loaded' })

    await invokeHandler({
      request_id: 'req-compute-gone',
      backend: 'llamacpp-upstream',
      model_id: 'm',
      trigger: 'compute_error_recovery',
    })

    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_done/req-compute-gone',
      { ok: false, reason: 'not-loaded' }
    )
  })

  it('has the core grow the window and tells the proxy and the UI the new size', async () => {
    const unloadSpy = vi.spyOn(ext, 'unload')
    const loadSpy = vi.spyOn(ext, 'load')
    coreAnswers({ ok: true, new_ctx_len: 32768 })

    await invokeHandler({
      request_id: 'req-1',
      backend: 'llamacpp-upstream',
      model_id: 'm',
      trigger: 'error',
    })

    // The reload is the core's: this extension does not own the process.
    expect(unloadSpy).not.toHaveBeenCalled()
    expect(loadSpy).not.toHaveBeenCalled()
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('atomic_core_call', {
      method: 'POST',
      path: '/models/llamacpp-upstream/m/ctx/increase',
      body: { reason: 'error' },
    })
    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_done/req-1',
      { ok: true, new_ctx_len: 32768 }
    )
    const notify = {
      provider: 'llamacpp-upstream',
      modelId: 'm',
      newCtxLen: 32768,
    }
    expect(eventsEmitMock).toHaveBeenCalledWith('OnAutoIncreasedCtxLen', notify)
    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_notify',
      notify
    )
  })

  it('stops at the model max ctx_train and emits the at_max event', async () => {
    coreAnswers({
      ok: false,
      reason: 'at_max',
      current_ctx_len: 32768,
      max_ctx_len: 32768,
    })

    await invokeHandler({
      request_id: 'req-max',
      backend: 'llamacpp-upstream',
      model_id: 'm',
      trigger: 'error',
    })

    const doneCall = emitMock.mock.calls.find(
      ([ch]) => ch === 'local_backend://auto_increase_ctx_done/req-max'
    )
    expect(doneCall?.[1]).toEqual({ ok: false, reason: 'at_max' })

    const atMaxCall = emitMock.mock.calls.find(
      ([ch]) => ch === 'local_backend://auto_increase_ctx_at_max'
    )
    expect(atMaxCall?.[1]).toEqual({
      provider: 'llamacpp-upstream',
      modelId: 'm',
      maxCtxLen: 32768,
      currentCtxLen: 32768,
    })
    expect(eventsEmitMock).not.toHaveBeenCalled()
  })

  it('reports the current size as the max when the model does not declare one', async () => {
    coreAnswers({ ok: false, reason: 'at_max', current_ctx_len: 49152 })

    await invokeHandler({
      request_id: 'req-max-unknown',
      backend: 'llamacpp-upstream',
      model_id: 'm',
      trigger: 'finish_length',
    })

    const atMaxCall = emitMock.mock.calls.find(
      ([ch]) => ch === 'local_backend://auto_increase_ctx_at_max'
    )
    expect(atMaxCall?.[1]).toMatchObject({ maxCtxLen: 49152, currentCtxLen: 49152 })
  })

  it('declines without the at_max toast when the model is not loaded', async () => {
    coreAnswers({ ok: false, reason: 'not-loaded' })

    await invokeHandler({
      request_id: 'req-gone',
      backend: 'llamacpp-upstream',
      model_id: 'm',
      trigger: 'error',
    })

    expect(emitMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenCalledWith(
      'local_backend://auto_increase_ctx_done/req-gone',
      { ok: false, reason: 'not-loaded' }
    )
  })

  it('emits done(ok:false, reason:exception:...) when the core call fails', async () => {
    coreAnswers(new Error('OOM'))

    await invokeHandler({
      request_id: 'req-4',
      backend: 'llamacpp-upstream',
      model_id: 'm',
      trigger: 'error',
    })

    expect(emitMock).toHaveBeenCalledTimes(1)
    const [channel, body] = emitMock.mock.calls[0]
    expect(channel).toBe('local_backend://auto_increase_ctx_done/req-4')
    expect(body).toMatchObject({ ok: false })
    expect(String((body as any).reason)).toContain('OOM')
  })
})

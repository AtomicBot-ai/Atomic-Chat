/**
 * The TurboQuant runtime lives in `atomic-chat-core` (PLAN.md §4): every operation that needs the
 * process, the backend packs on disk or the optimal-backend record goes to the core, and nothing
 * reaches the plugin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { emitMock, listeners } = vi.hoisted(() => ({
  emitMock: vi.fn().mockResolvedValue(undefined),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}))
vi.mock('@tauri-apps/api/event', () => ({
  emit: emitMock,
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler)
    return () => listeners.delete(name)
  }),
}))

import { invoke } from '@tauri-apps/api/core'
import { events } from '@janhq/core'
import llamacpp_extension from '../index'
import { getSystemInfo } from '../hardware'

const invokeMock = vi.mocked(invoke)

type Route = (body: unknown) => unknown
function core(routes: Record<string, Route>, snapshot: unknown = { optimal_backends: {} }) {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  invokeMock.mockImplementation((async (command: string, args?: Record<string, unknown>) => {
    if (command === 'atomic_core_status')
      return { running: true, attached: { instance_id: 'i', generation: 1 } }
    if (command === 'atomic_core_snapshot') return { snapshot }
    if (command === 'atomic_core_call') {
      const call = { method: String(args?.['method']), path: String(args?.['path']), body: args?.['body'] }
      calls.push(call)
      const route = routes[`${call.method} ${call.path}`]
      if (!route) throw new Error(`unrouted ${call.method} ${call.path}`)
      return route(call.body)
    }
    throw new Error(`plugin reached: ${command}`)
  }) as never)
  return calls
}

const session = { pid: 42, port: 3456, model_id: 'org/m', model_path: '/m.gguf', is_embedding: false, api_key: 'k' }

function extension() {
  const ext = new llamacpp_extension()
  ;(ext as unknown as { config: Record<string, unknown> }).config = { ctx_size: 4096, fit: false }
  ;(ext as unknown as { getSettings: () => Promise<unknown[]> }).getSettings = async () => [
    { key: 'ctx_size', controllerProps: { value: 4096 } },
  ]
  ;(ext as unknown as { updateSettings: () => Promise<void> }).updateSettings = async () => {}
  return ext
}

beforeEach(() => {
  vi.clearAllMocks()
  listeners.clear()
  vi.mocked(getSystemInfo).mockResolvedValue({ gpus: [], os_type: 'macos', cpu: { extensions: [] } } as never)
})

describe('TurboQuant runtime in the core', () => {
  it('hands the settings over, then loads through the core with the per-model overrides', async () => {
    const calls = core({
      'GET /sessions': () => ({ sessions: [] }),
      'POST /settings/llamacpp/import': () => ({ status: 'imported', applied: [], conflicts: [], revision: 1 }),
      'GET /settings/llamacpp': () => ({ provider: 'llamacpp', revision: 2, values: { ctx_size: 4096 } }),
      'POST /settings/llamacpp/acknowledge': () => ({}),
      'PUT /hardware/override': () => ({}),
      'POST /models/llamacpp/org/m/load': () => ({ session, created: true }),
    })
    const loaded = await extension().load('org/m', { ctx_size: 8192 }, false, true)
    expect(loaded).toEqual(session)
    // Only core commands: no runtime-load bracket, no plugin.
    expect(new Set(invokeMock.mock.calls.map(([command]) => command))).toEqual(
      new Set(['atomic_core_call', 'atomic_core_status'])
    )
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /sessions',
      'POST /settings/llamacpp/import',
      'GET /settings/llamacpp',
      'POST /settings/llamacpp/acknowledge',
      'PUT /hardware/override',
      'POST /models/llamacpp/org/m/load',
    ])
    expect(calls.at(-1)?.body).toEqual({ overrides: { ctx_size: 8192 }, isEmbedding: false, bypassAutoUnload: true })
  })

  it('reports a core load failure with its code', async () => {
    core({
      'GET /sessions': () => ({ sessions: [] }),
      'POST /settings/llamacpp/import': () => {
        throw { code: 'IO_ERROR', message: 'disk' }
      },
    })
    await expect(extension().load('org/m')).rejects.toThrow('Atomic core settings import failed: disk [IO_ERROR]')
  })

  it('finds, lists and unloads sessions in the core, never in the plugin', async () => {
    const calls = core({
      'GET /sessions': () => ({ sessions: [{ ...session, provider: 'llamacpp' }, { ...session, model_id: 'x', provider: 'mlx' }] }),
      'POST /models/llamacpp/org/m/unload': () => ({ success: true }),
    })
    const ext = extension()
    expect(await ext.getLoadedModels()).toEqual(['org/m'])
    await expect(ext.load('org/m')).rejects.toThrow('Model already loaded!!')
    expect(await ext.unload('org/m')).toEqual({ success: true })
    expect(calls.at(-1)?.path).toBe('/models/llamacpp/org/m/unload')
  })

  it('turns a failed core unload into an unload result', async () => {
    core({ 'POST /models/llamacpp/org/m/unload': () => Promise.reject({ code: 'CORE_NOT_RUNNING', message: 'stopping' }) })
    expect(await extension().unload('org/m')).toEqual({
      success: false,
      error: 'Failed to unload model: stopping [CORE_NOT_RUNNING]',
    })
  })

  it('chats with a core session without asking the plugin whether the process runs', async () => {
    core({ 'GET /sessions': () => ({ sessions: [{ ...session, provider: 'llamacpp' }] }) })
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/health')
        ? new Response('{}')
        : new Response(JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }), {
            headers: { 'content-type': 'application/json' },
          })
    )
    vi.stubGlobal('fetch', fetchMock)
    const answer = await extension().chat({ model: 'org/m', messages: [{ role: 'user', content: 'hi' }] } as never)
    expect(answer).toMatchObject({ choices: [{ message: { content: 'hi' } }] })
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain('http://localhost:3456/v1/chat/completions')
    vi.unstubAllGlobals()
  })

  it('asks the core to grow the context, to restart a poisoned engine, and relays at_max', async () => {
    let outcome: unknown = { ok: true, new_ctx_len: 8192 }
    const calls = core({
      'POST /models/llamacpp/org/m/ctx/increase': () => outcome,
      'POST /models/llamacpp/org/m/recreate': () => ({ ok: false, reason: 'not-loaded' }),
    })
    const ext = extension()
    const handle = (trigger: string, id: string) =>
      (ext as unknown as { handleAutoIncreaseCtx: (p: unknown) => Promise<void> }).handleAutoIncreaseCtx({
        request_id: id,
        backend: 'llamacpp',
        model_id: 'org/m',
        trigger,
      })
    await handle('error', 'r1')
    expect(emitMock).toHaveBeenCalledWith('local_backend://auto_increase_ctx_done/r1', { ok: true, new_ctx_len: 8192 })
    expect(emitMock).toHaveBeenCalledWith('local_backend://auto_increase_ctx_notify', {
      provider: 'llamacpp',
      modelId: 'org/m',
      newCtxLen: 8192,
    })
    expect(events.emit).toHaveBeenCalledWith('OnAutoIncreasedCtxLen', expect.objectContaining({ newCtxLen: 8192 }))
    outcome = { ok: false, reason: 'at_max', current_ctx_len: 32768, max_ctx_len: 32768 }
    await handle('finish_length', 'r2')
    expect(emitMock).toHaveBeenCalledWith('local_backend://auto_increase_ctx_done/r2', { ok: false, reason: 'at_max' })
    expect(emitMock).toHaveBeenCalledWith('local_backend://auto_increase_ctx_at_max', {
      provider: 'llamacpp',
      modelId: 'org/m',
      maxCtxLen: 32768,
      currentCtxLen: 32768,
    })
    await handle('compute_error_recovery', 'r3')
    expect(emitMock).toHaveBeenCalledWith('local_backend://auto_increase_ctx_done/r3', { ok: false, reason: 'not-loaded' })
    expect(calls.map((c) => c.body)).toEqual([{ reason: 'error' }, { reason: 'finish_length' }, null])
  })

  it('installs a backend through the core under the progress task the UI listens on', async () => {
    const calls = core({
      'POST /backends/llamacpp/install': () => {
        listeners.get('download-llamacpp-backend-b10018-1_3_0/linux-x64-rocm')?.({ payload: { transferred: 5, total: 10 } })
        return { installed: true }
      },
    })
    const backendModule = await import('../backend')
    vi.spyOn(backendModule, 'isBackendInstalled').mockResolvedValue(false)
    await (extension() as unknown as { downloadAndInstallBackend: (s: string) => Promise<void> }).downloadAndInstallBackend(
      'b10018-1.3.0/linux-x64-rocm'
    )
    expect(calls[0]?.body).toMatchObject({ version: 'b10018-1.3.0', backend: 'linux-x64-rocm', task_id: 'llamacpp-backend-b10018-1_3_0/linux-x64-rocm' })
    expect(events.emit).toHaveBeenCalledWith('onFileDownloadUpdate', expect.objectContaining({ percent: 0.5 }))
    expect(events.emit).toHaveBeenCalledWith('onFileDownloadAndVerificationSuccess', expect.anything())

    core({ 'POST /backends/llamacpp/install': () => Promise.reject({ code: 'IO_ERROR', message: '404' }) })
    await expect(
      (extension() as unknown as { downloadAndInstallBackend: (s: string) => Promise<void> }).downloadAndInstallBackend(
        'b10018-1.3.0/linux-x64-rocm'
      )
    ).rejects.toThrow('404 [IO_ERROR]')
    expect(events.emit).toHaveBeenCalledWith('onFileDownloadError', expect.objectContaining({ error: '404 [IO_ERROR]' }))
  })

  it('lists devices from the core without preparing a backend itself', async () => {
    core({ 'GET /hardware/devices?provider=llamacpp': () => ({ devices: [{ id: 'Metal', name: 'M', mem: 1, free: 1 }] }) })
    vi.mocked(getSystemInfo).mockResolvedValue({ os_type: 'macos', gpus: [] } as never)
    const ext = extension()
    ;(ext as unknown as { config: Record<string, unknown> }).config = { version_backend: 'b10018-1.3.0/macos-arm64' }
    expect(await ext.getDevices()).toEqual([{ id: 'Metal', name: 'M', mem: 1, free: 1 }])
  })

  it('mirrors core settings changed elsewhere, only for its own provider', async () => {
    const calls = core({
      'GET /settings/llamacpp': () => ({ provider: 'llamacpp', revision: 9, values: { version_backend: 'b1-1.0.0/macos-arm64' } }),
      'POST /settings/llamacpp/acknowledge': () => ({}),
    })
    const ext = extension()
    ;(ext as unknown as { getSettings: () => Promise<unknown[]> }).getSettings = async () => [
      { key: 'version_backend', controllerProps: { value: 'old/macos-arm64' } },
    ]
    const ensureBackendReady = vi.fn()
    ;(ext as unknown as { ensureBackendReady: unknown }).ensureBackendReady = ensureBackendReady
    ;(ext as unknown as { updateSettings: (s: Array<{ key: string; controllerProps: { value: unknown } }>) => Promise<void> }).updateSettings =
      async (settings) => {
        for (const setting of settings)
          (ext as unknown as { onSettingUpdate: (k: string, v: unknown) => void }).onSettingUpdate(setting.key, setting.controllerProps.value)
      }
    await (ext as unknown as { listenForCoreSettings: () => Promise<void> }).listenForCoreSettings()
    const fire = listeners.get('atomic-core://settings:changed')

    fire?.({ payload: { provider: 'mlx' } })
    fire?.({ payload: { provider: 'llamacpp' } })
    await vi.waitFor(() => expect(calls.map((c) => c.path)).toEqual(['/settings/llamacpp', '/settings/llamacpp/acknowledge']))
    // The mirror updates the in-memory value and starts no backend download.
    expect((ext as unknown as { config: Record<string, unknown> }).config['version_backend']).toBe('b1-1.0.0/macos-arm64')
    expect(ensureBackendReady).not.toHaveBeenCalled()

    ;(ext as unknown as { onUnload: () => Promise<void> }).onUnload()
    expect(listeners.has('atomic-core://settings:changed')).toBe(false)
  })

  it('reports the device the core snapshotted on the session, and null when it is not loaded', async () => {
    const runtime_device = { primary_device: 'CUDA0', gpu_layers_offloaded: 33, total_layers: 33 }
    core({ 'GET /sessions': () => ({ sessions: [{ ...session, provider: 'llamacpp', runtime_device }] }) })
    const ext = extension()
    expect(await ext.getRuntimeDeviceInfo('org/m')).toEqual(runtime_device)
    expect(await ext.getRuntimeDeviceInfo('other')).toBeNull()

    core({ 'GET /sessions': () => Promise.reject({ code: 'CORE_NOT_RUNNING', message: 'down' }) })
    expect(await ext.getRuntimeDeviceInfo('org/m')).toBeNull()
  })

  it('lists installed backend packs from the core, marking the selected one', async () => {
    const packs = [
      { version: 'b10018-1.3.0', backend: 'linux-x64-rocm', path: '/data/llamacpp/backends/b10018-1.3.0/linux-x64-rocm', active: true },
      { version: 'b9937-1.2.0', backend: 'linux-x64-vulkan', path: '/data/llamacpp/backends/b9937-1.2.0/linux-x64-vulkan', active: false },
    ]
    const calls = core({
      'GET /backends/llamacpp?current=b10018-1.3.0%2Flinux-x64-rocm': () => ({ backends: packs }),
    })
    const ext = extension()
    ;(ext as unknown as { config: Record<string, unknown> }).config = {
      version_backend: '\uFEFFb10018-1.3.0/linux-x64-rocm',
    }
    expect(await ext.listInstalledBackends()).toEqual(packs)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /backends/llamacpp?current=b10018-1.3.0%2Flinux-x64-rocm',
    ])
  })

  it('removes a backend pack through the core, but never the selected one', async () => {
    const calls = core({
      'DELETE /backends/llamacpp/b9937-1.2.0/linux-x64-vulkan': () => ({ removed: true }),
    })
    const ext = extension()
    ;(ext as unknown as { config: Record<string, unknown> }).config = {
      version_backend: 'b10018-1.3.0/linux-x64-rocm',
    }
    await ext.deleteBackend(' b9937-1.2.0', 'linux-x64-vulkan\uFEFF')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'DELETE /backends/llamacpp/b9937-1.2.0/linux-x64-vulkan',
    ])

    await expect(ext.deleteBackend('b10018-1.3.0', 'linux-x64-rocm')).rejects.toThrow(
      'Cannot remove the backend that is currently selected'
    )
    await expect(ext.deleteBackend('..', 'linux-x64-rocm')).rejects.toThrow('Invalid backend pack')
    expect(calls).toHaveLength(1)

    core({
      'DELETE /backends/llamacpp/b9937-1.2.0/linux-x64-vulkan': () =>
        Promise.reject({ code: 'IO_ERROR', message: 'busy' }),
    })
    await expect(ext.deleteBackend('b9937-1.2.0', 'linux-x64-vulkan')).rejects.toThrow('busy [IO_ERROR]')
  })

  describe('optimal-backend record', () => {
    const cpuRecord = {
      schemaVersion: 1,
      detectedAt: 1_700_000_000_000,
      provider: 'llamacpp',
      detectionKind: 'cpu-optimal',
      currentBackend: 'b10018-1.3.0/linux-x64-vulkan',
      recommendedCategory: 'CPU',
    }
    const KEY = 'atomic_llamacpp_turboquant_optimal_backend_v1'

    beforeEach(() => {
      vi.mocked(localStorage.setItem).mockReset()
      vi.mocked(localStorage.removeItem).mockReset()
      vi.mocked(localStorage.getItem).mockReset()
    })

    type OptimalInternals = {
      config: Record<string, unknown>
      optimalRevision: number
      adoptOptimalFromCore: () => Promise<void>
      listenForCoreOptimal: () => Promise<void>
      refreshOptimalBackendCache: (o?: { hardwareHasNoGpu?: boolean }) => Promise<unknown>
    }

    it('stores a detection in the core first, then keeps the local copy at the revision it got', async () => {
      const calls = core({
        'PUT /backends/llamacpp/optimal': (body) => {
          const { optimal } = body as { optimal: unknown }
          return { status: 'updated', current: { revision: 4, optimal } }
        },
      })
      const ext = extension() as unknown as OptimalInternals
      ext.config = { version_backend: 'b10018-1.3.0/linux-x64-vulkan' }
      ext.optimalRevision = 3

      const record = await ext.refreshOptimalBackendCache({ hardwareHasNoGpu: true })

      expect(calls).toEqual([
        { method: 'PUT', path: '/backends/llamacpp/optimal', body: { optimal: record, expected_revision: 3 } },
      ])
      expect(localStorage.setItem).toHaveBeenCalledWith(KEY, JSON.stringify(record))
      expect(ext.optimalRevision).toBe(4)
    })

    it('takes the core record and rethrows when a newer revision won, leaving the local copy on it', async () => {
      core({
        'PUT /backends/llamacpp/optimal': () =>
          Promise.reject({ code: 'CONFLICT', message: 'revision changed' }),
        'GET /backends/llamacpp/optimal': () => ({ revision: 7, optimal: cpuRecord }),
      })
      const ext = extension() as unknown as OptimalInternals
      ext.config = { version_backend: 'b10018-1.3.0/linux-x64-cuda-13.3' }

      await expect(ext.refreshOptimalBackendCache({ hardwareHasNoGpu: true })).rejects.toThrow(
        'revision changed [CONFLICT]'
      )
      expect(ext.optimalRevision).toBe(7)
      expect(vi.mocked(localStorage.setItem).mock.calls).toEqual([[KEY, JSON.stringify(cpuRecord)]])
    })

    it('adopts the stored record at startup, from the snapshot when there is one', async () => {
      const calls = core({}, { optimal_backends: { llamacpp: { revision: 2, optimal: cpuRecord } } })
      const ext = extension() as unknown as OptimalInternals
      await ext.adoptOptimalFromCore()
      expect(calls).toEqual([])
      expect(localStorage.setItem).toHaveBeenCalledWith(KEY, JSON.stringify(cpuRecord))
      expect(ext.optimalRevision).toBe(2)
      // The synchronous reader the web-app uses sees the adopted record.
      vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
        key === KEY ? JSON.stringify(cpuRecord) : null
      )
      expect((ext as unknown as llamacpp_extension).getCachedOptimalBackend()).toEqual(cpuRecord)

      vi.mocked(localStorage.getItem).mockReturnValue(null)
      core({ 'GET /backends/llamacpp/optimal': () => ({ revision: 0, optimal: null }) }, { optimal_backends: {} })
      const fresh = extension() as unknown as OptimalInternals
      await fresh.adoptOptimalFromCore()
      expect(localStorage.removeItem).toHaveBeenCalledWith(KEY)
    })

    it('imports an old app-only optimum exactly once when the core cache is empty', async () => {
      vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
        key === KEY ? JSON.stringify(cpuRecord) : null
      )
      const calls = core({
        'PUT /backends/llamacpp/optimal': (body) => ({
          status: 'updated', current: { revision: 1, optimal: (body as { optimal: unknown }).optimal },
        }),
      }, { optimal_backends: { llamacpp: { revision: 0, optimal: null } } })
      const ext = extension() as unknown as OptimalInternals
      await ext.adoptOptimalFromCore()
      expect(calls).toEqual([{
        method: 'PUT', path: '/backends/llamacpp/optimal',
        body: { optimal: cpuRecord, expected_revision: 0 },
      }])
      expect(ext.optimalRevision).toBe(1)
      expect(localStorage.removeItem).not.toHaveBeenCalled()
    })

    it('follows records changed elsewhere, ignoring other providers and older revisions', async () => {
      core({})
      const ext = extension() as unknown as OptimalInternals
      await ext.listenForCoreOptimal()
      const changed = listeners.get('atomic-core://backend:optimal-changed')

      changed?.({ payload: { provider: 'llamacpp-upstream', revision: 9, optimal: null } })
      changed?.({ payload: { provider: 'llamacpp', revision: 5, optimal: cpuRecord } })
      changed?.({ payload: { provider: 'llamacpp', revision: 4, optimal: null } })

      expect(vi.mocked(localStorage.setItem).mock.calls).toEqual([[KEY, JSON.stringify(cpuRecord)]])
      expect(localStorage.removeItem).not.toHaveBeenCalled()
      expect(ext.optimalRevision).toBe(5)

      listeners.get('atomic-core://snapshot')?.({
        payload: { snapshot: { optimal_backends: { llamacpp: { revision: 6, optimal: null } } } },
      })
      expect(localStorage.removeItem).toHaveBeenCalledWith(KEY)
      expect(ext.optimalRevision).toBe(6)
    })
  })
})

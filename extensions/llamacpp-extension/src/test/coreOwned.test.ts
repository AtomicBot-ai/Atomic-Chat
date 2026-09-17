/**
 * The TurboQuant runtime handed to `atomic-chat-core` (`atomic_core.runtime = all`, PLAN.md stage 5):
 * every operation that needs the process goes to the core, and nothing reaches the plugin.
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
function core(routes: Record<string, Route>, runtime: string | null = 'all') {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  invokeMock.mockImplementation((async (command: string, args?: Record<string, unknown>) => {
    if (command === 'atomic_core_begin_runtime_load') return 1
    if (command === 'atomic_core_end_runtime_load') return undefined
    if (command === 'atomic_core_status')
      return { active_runtime: runtime, attached: { instance_id: 'i', generation: 1 } }
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

describe('TurboQuant runtime owned by the core', () => {
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
    const commands = invokeMock.mock.calls.map(([command]) => command)
    expect(commands[0]).toBe('atomic_core_begin_runtime_load')
    expect(commands.at(-1)).toBe('atomic_core_end_runtime_load')
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

  it('mirrors core settings changed elsewhere, only for its own provider and only while owned', async () => {
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

    core({}, 'llamacpp-upstream')
    fire?.({ payload: { provider: 'llamacpp' } })
    await new Promise((r) => setTimeout(r, 10))
    ;(ext as unknown as { onUnload: () => Promise<void> }).onUnload()
    expect(listeners.has('atomic-core://settings:changed')).toBe(false)
  })
})

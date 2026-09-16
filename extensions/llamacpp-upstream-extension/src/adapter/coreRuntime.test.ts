import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

import {
  CORE_PROVIDER,
  coreOwnsRuntime,
  describeCoreError,
  findSession,
  getSettings,
  getStatus,
  getLoadedModels,
  importSettings,
  increaseContext,
  isCoreError,
  load,
  modelIdsMatch,
  sendHardwareOverride,
  unload,
} from './coreRuntime'

const session = (model_id: string, port: number, provider = CORE_PROVIDER) => ({
  pid: 1,
  port,
  model_id,
  model_path: `/models/${model_id}.gguf`,
  is_embedding: false,
  api_key: `key-${port}`,
  provider,
})

beforeEach(() => {
  invoke.mockReset()
})

/** The single call the command receives, as `(name, args)`. */
const lastCall = () =>
  invoke.mock.calls.at(-1) as [string, Record<string, unknown>]

describe('talking to the core', () => {
  it('sends every request through the Rust command, never over HTTP', () => {
    // The control token lives in Rust; a URL here would mean the webview held a credential.
    invoke.mockResolvedValue({ sessions: [] })

    void getLoadedModels()

    expect(lastCall()[0]).toBe('atomic_core_call')
  })

  it('loads a model with its per-model overrides', async () => {
    invoke.mockResolvedValue({
      session: session('vendor/model', 3001),
      created: true,
    })

    const loaded = await load('vendor/model', {
      settings: { ctx_size: 8192 },
      isEmbedding: true,
      bypassAutoUnload: true,
    })

    const [, args] = lastCall()
    expect(args.method).toBe('POST')
    expect(args.path).toBe('/models/llamacpp-upstream/vendor/model/load')
    expect(args.body).toEqual({
      overrides: { ctx_size: 8192 },
      isEmbedding: true,
      bypassAutoUnload: true,
    })
    expect(loaded).toEqual(session('vendor/model', 3001))
  })

  it('omits options the caller did not set, so the core applies its own defaults', async () => {
    invoke.mockResolvedValue({ session: session('m', 3001), created: false })

    await load('m')

    expect(lastCall()[1].body).toEqual({})
  })

  it('unloads through the core rather than killing a process itself', async () => {
    invoke.mockResolvedValue({ success: true })

    await unload('m')

    expect(lastCall()[1]).toMatchObject({
      method: 'POST',
      path: '/models/llamacpp-upstream/m/unload',
    })
  })
})

describe('finding a session', () => {
  it('asks the core every time instead of remembering a port', async () => {
    // The defect this prevents: a model reloaded with a bigger context answers on a new port, and
    // a cached one keeps pointing at a process that is gone.
    invoke.mockResolvedValueOnce({ sessions: [session('m', 3001)] })
    expect((await findSession('m'))?.port).toBe(3001)

    invoke.mockResolvedValueOnce({ sessions: [session('m', 3999)] })
    expect((await findSession('m'))?.port).toBe(3999)

    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('reports nothing for a model that is not loaded', async () => {
    invoke.mockResolvedValue({ sessions: [session('other', 3001)] })

    expect(await findSession('m')).toBeUndefined()
  })

  it('ignores sessions belonging to another provider', async () => {
    invoke.mockResolvedValue({ sessions: [session('m', 3100, 'mlx')] })

    expect(await findSession('m')).toBeUndefined()
    expect(await getLoadedModels()).toEqual([])
  })

  it('treats a session with no provider as this one, as older cores sent it', async () => {
    const bare = session('m', 3001)
    delete (bare as { provider?: string }).provider
    invoke.mockResolvedValue({ sessions: [bare] })

    expect((await findSession('m'))?.port).toBe(3001)
  })

  it('survives a core that answers without a session list', async () => {
    invoke.mockResolvedValue({})

    expect(await getLoadedModels()).toEqual([])
  })
})

describe('modelIdsMatch', () => {
  it('treats a dot and an underscore as the same character, as the proxy does', () => {
    expect(modelIdsMatch('Qwen3.5-9B', 'Qwen3_5-9B')).toBe(true)
    expect(modelIdsMatch('Qwen3.5-9B', 'Qwen3.5-9B')).toBe(true)
    expect(modelIdsMatch('a', 'ab')).toBe(false)
    expect(modelIdsMatch('a-b', 'a.b')).toBe(false)
  })
})

describe('context increase', () => {
  it('passes the reason through and returns the core’s refusal as an outcome', async () => {
    invoke.mockResolvedValue({
      ok: false,
      reason: 'at_max',
      current_ctx_len: 8192,
    })

    const result = await increaseContext('m', 'proxy-overflow')

    expect(lastCall()[1]).toMatchObject({
      path: '/models/llamacpp-upstream/m/ctx/increase',
      body: { reason: 'proxy-overflow' },
    })
    expect(result).toEqual({
      ok: false,
      reason: 'at_max',
      current_ctx_len: 8192,
    })
  })
})

describe('settings import', () => {
  it('sends the app’s values and reports a conflict rather than resolving it', async () => {
    invoke.mockResolvedValue({
      status: 'conflict',
      applied: [],
      conflicts: [{ key: 'ctx_size', base: 4096, core: 2048, legacy: 8192 }],
      revision: 7,
    })

    const result = await importSettings({ ctx_size: 8192 })

    expect(lastCall()[1]).toMatchObject({
      method: 'POST',
      path: '/settings/llamacpp-upstream/import',
      body: { values: { ctx_size: 8192 } },
    })
    expect(result.status).toBe('conflict')
  })

  it('forwards resolutions when the user has chosen', async () => {
    invoke.mockResolvedValue({
      status: 'merged',
      applied: ['ctx_size'],
      conflicts: [],
      revision: 8,
    })

    await importSettings({ ctx_size: 8192 }, { ctx_size: 'legacy' })

    expect(
      (lastCall()[1].body as { resolutions: unknown }).resolutions
    ).toEqual({
      ctx_size: 'legacy',
    })
  })

  it('reads the canonical core values before acknowledging a mirrored revision', async () => {
    invoke.mockResolvedValue({
      provider: CORE_PROVIDER,
      revision: 9,
      values: { ctx_size: 16384 },
      migration: { acknowledged_revision: 8 },
    })

    expect(await getSettings()).toMatchObject({
      revision: 9,
      values: { ctx_size: 16384 },
    })
    expect(lastCall()[1]).toMatchObject({
      method: 'GET',
      path: '/settings/llamacpp-upstream',
    })
  })
})

describe('hardware override', () => {
  it('stamps the source so the core can say where its numbers came from', async () => {
    invoke.mockResolvedValue({ override: {} })

    await sendHardwareOverride({
      gpus: [{ vendor: 'NVIDIA' }],
      cpu_extensions: ['avx2'],
    })

    expect(lastCall()[1]).toMatchObject({
      method: 'PUT',
      path: '/hardware/override',
      body: { source: 'tauri-plugin-hardware' },
    })
  })
})

describe('the ownership flag', () => {
  it('is read per call, because it can be flipped while the app runs', async () => {
    invoke.mockResolvedValueOnce({ active_runtime: CORE_PROVIDER })
    expect(await coreOwnsRuntime()).toBe(true)

    invoke.mockResolvedValueOnce({
      active_runtime: null,
      flags: { runtime: null },
    })
    expect(await coreOwnsRuntime()).toBe(false)
  })

  it('uses persisted flags only for compatibility with a status response without active ownership', async () => {
    invoke.mockResolvedValue({
      flags: { attach: true, runtime: CORE_PROVIDER },
    })

    expect(await coreOwnsRuntime()).toBe(true)
  })

  it('exposes attachment generation for readiness caching', async () => {
    invoke.mockResolvedValue({
      active_runtime: CORE_PROVIDER,
      attached: { instance_id: 'core-a', generation: 4 },
    })

    expect(await getStatus()).toMatchObject({
      attached: { instance_id: 'core-a', generation: 4 },
    })
    expect(lastCall()[0]).toBe('atomic_core_status')
  })

  it('does not route an operation while ownership is transitioning', async () => {
    invoke.mockResolvedValue({ transitioning: true, active_runtime: null })

    await expect(coreOwnsRuntime()).rejects.toMatchObject({
      code: 'CORE_TRANSITIONING',
    })
  })

  it('reads as off in a build that has no core at all', async () => {
    invoke.mockRejectedValue(new Error('unknown command'))

    expect(await coreOwnsRuntime()).toBe(false)
  })
})

describe('errors', () => {
  it('keeps the core’s code, which callers branch on', () => {
    const error = {
      code: 'CORE_ALREADY_RUNNING',
      message: 'busy',
      details: 'pid 7',
    }

    expect(isCoreError(error)).toBe(true)
    expect(describeCoreError(error)).toBe('busy (pid 7) [CORE_ALREADY_RUNNING]')
    expect(describeCoreError(new Error('boom'))).toContain('boom')
  })
})

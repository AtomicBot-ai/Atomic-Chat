/**
 * The shared adapter, as the TurboQuant, MLX and Foundation Models extensions bind it. The upstream
 * binding is covered by `coreRuntime.test.ts`; this pins what differs per provider.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  createCoreRuntime,
  runtimeCovers,
} from '../../../shared/atomicCoreRuntime'
import type { Invoke } from '../../../shared/atomicCoreRuntime'

function bound(
  provider: 'llamacpp' | 'mlx' | 'foundation-models',
  answer: (command: string, args?: Record<string, unknown>) => unknown
) {
  const invoke = vi.fn(
    async (command: string, args?: Record<string, unknown>) =>
      answer(command, args)
  )
  return {
    invoke,
    core: createCoreRuntime(provider, invoke as unknown as Invoke),
  }
}

describe('shared core adapter', () => {
  it('holds a Foundation Models owner lease through a slow load and releases it on failure', async () => {
    const calls: string[] = []
    const { core } = bound('foundation-models', (command) => {
      calls.push(command)
      if (command === 'atomic_core_begin_runtime_load') return 12
      return undefined
    })
    await expect(
      core.withRuntimeLoad(async () => {
        calls.push('spawn')
        throw new Error('startup failed')
      })
    ).rejects.toThrow('startup failed')
    expect(calls).toEqual([
      'atomic_core_begin_runtime_load',
      'spawn',
      'atomic_core_end_runtime_load',
    ])
  })

  it('keeps the mobile legacy path when desktop core commands are absent', async () => {
    const { core } = bound('foundation-models', () => {
      throw new Error('unknown command atomic_core_begin_runtime_load')
    })
    expect(await core.withRuntimeLoad(async () => 'legacy')).toBe('legacy')
  })

  it('counts "all" as owning every provider, and a single owner only for itself', async () => {
    expect(runtimeCovers('all', 'mlx')).toBe(true)
    expect(runtimeCovers('llamacpp-upstream', 'mlx')).toBe(false)
    expect(runtimeCovers(null, 'foundation-models')).toBe(false)
    for (const [status, owns] of [
      [{ active_runtime: 'all' }, true],
      [{ active_runtime: 'llamacpp-upstream' }, false],
      [{ active_runtime: null, flags: { runtime: 'all' } }, false],
      [{ flags: { runtime: 'all' } }, true],
      [undefined, false],
    ] as const) {
      const { core } = bound('mlx', () => status)
      expect(await core.coreOwnsRuntime()).toBe(owns)
    }
  })

  it('addresses its own provider in every path and sees only its own sessions', async () => {
    const { core, invoke } = bound('mlx', (command, args) => {
      if (args?.['path'] === '/sessions')
        return {
          sessions: [
            { model_id: 'qwen_mlx', port: 1, provider: 'mlx' },
            { model_id: 'qwen.mlx', port: 2, provider: 'llamacpp' },
            { model_id: 'legacy', port: 3 },
          ],
        }
      if (String(args?.['path']).endsWith('/load'))
        return { session: { model_id: 'q', port: 4 }, created: true }
      return {}
    })
    expect(await core.getLoadedModels()).toEqual(['qwen_mlx'])
    expect((await core.findSession('qwen.mlx'))?.port).toBe(1)
    await core.load('org/q', {
      settings: { draft_model_path: '/d' },
      bypassAutoUnload: true,
    })
    await core.importSettings({ kv_bits: 4 })
    expect(invoke.mock.calls.slice(-2).map(([, args]) => args)).toEqual([
      {
        method: 'POST',
        path: '/models/mlx/org/q/load',
        body: { overrides: { draft_model_path: '/d' }, bypassAutoUnload: true },
      },
      {
        method: 'POST',
        path: '/settings/mlx/import',
        body: { values: { kv_bits: 4 } },
      },
    ])
  })

  it('names the TurboQuant asset on install only when one is known', async () => {
    const { core, invoke } = bound('llamacpp', () => ({ installed: true }))
    await core.installBackend(
      'b1-1.0.0',
      'linux-x64-rocm',
      'task',
      false,
      null,
      'rocm.tar.gz'
    )
    await core.installBackend('b1-1.0.0', 'linux-x64-rocm', 'task')
    expect(
      invoke.mock.calls.map(
        ([, args]) => (args?.['body'] as Record<string, unknown>)['asset_name']
      )
    ).toEqual(['rocm.tar.gz', undefined])
  })

  it('asks the core whether Apple Intelligence can run, forcing a fresh check on request', async () => {
    const { core, invoke } = bound('foundation-models', () => ({
      status: 'modelNotReady',
    }))
    expect(await core.foundationModelsAvailability()).toBe('modelNotReady')
    await core.foundationModelsAvailability(true)
    expect(invoke.mock.calls.map(([, args]) => args?.['path'])).toEqual([
      '/runtimes/foundation-models/availability',
      '/runtimes/foundation-models/availability?force=1',
    ])
  })

  it('embeds with a named model under its provider', async () => {
    const { core, invoke } = bound('llamacpp', () => ({ data: [] }))
    await core.embed(['a'], 512, 'nomic')
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      method: 'POST',
      path: '/models/llamacpp/nomic/embed',
      body: { input: ['a'], ubatch_size: 512 },
    })
  })
})

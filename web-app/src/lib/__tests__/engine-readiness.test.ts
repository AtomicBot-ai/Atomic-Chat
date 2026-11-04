import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '@janhq/core'
import type { ServiceHub } from '@/services'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke: invokeMock,
}))

import {
  probeEngineHealth,
  waitForEngineReady,
  type EngineHealth,
  type EngineReadinessDeps,
} from '../engine-readiness'

const session = (port: number) =>
  ({ port, api_key: 'k', model_id: 'm', pid: 1 }) as unknown as SessionInfo

const serviceHub = {} as ServiceHub

/** Scripted engine: a session table, a health answer per probe, and a clock. */
function fakeEngine(opts: {
  sessions: Array<SessionInfo | null>
  health?: EngineHealth[]
  start?: () => Promise<void>
}) {
  let clock = 0
  const sessions = [...opts.sessions]
  const health = [...(opts.health ?? [])]
  const calls: string[] = []
  const deps: EngineReadinessDeps = {
    findSession: async () => {
      calls.push('find')
      return sessions.length > 1 ? sessions.shift()! : (sessions[0] ?? null)
    },
    probe: async (s) => {
      calls.push(`probe:${s.port}`)
      return health.length > 1 ? health.shift()! : (health[0] ?? 'ready')
    },
    start: async () => {
      calls.push('start')
      await opts.start?.()
    },
    stop: async () => {
      calls.push('stop')
    },
    invalidate: () => {},
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
  }
  return { deps, calls }
}

describe('waitForEngineReady', () => {
  it('answers at once when the session is alive', async () => {
    const { deps, calls } = fakeEngine({ sessions: [session(3001)] })
    expect(
      await waitForEngineReady(
        { providerId: 'llamacpp-upstream', modelId: 'm', serviceHub },
        deps
      )
    ).toEqual({ ok: true, port: 3001, restarted: false })
    expect(calls).toEqual(['find', 'probe:3001'])
  })

  it('starts the model when it has no session, then waits for it', async () => {
    const { deps, calls } = fakeEngine({
      sessions: [null, session(3002)],
      health: ['loading', 'ready'],
    })
    expect(
      await waitForEngineReady(
        { providerId: 'llamacpp', modelId: 'm', serviceHub },
        deps
      )
    ).toEqual({ ok: true, port: 3002, restarted: true })
    expect(calls).toEqual([
      'find',
      'start',
      'find',
      'probe:3002',
      'find',
      'probe:3002',
    ])
  })

  it('unloads and reloads a listed session that keeps refusing (stale mirror)', async () => {
    const { deps, calls } = fakeEngine({
      sessions: [session(3003), session(3003), session(3003), session(3004)],
      health: ['unreachable', 'unreachable', 'unreachable', 'ready'],
    })
    expect(
      await waitForEngineReady(
        { providerId: 'llamacpp-upstream', modelId: 'm', serviceHub },
        deps
      )
    ).toEqual({ ok: true, port: 3004, restarted: true })
    expect(calls.filter((c) => c === 'stop' || c === 'start')).toEqual([
      'stop',
      'start',
    ])
  })

  it('restarts at most once', async () => {
    const { deps, calls } = fakeEngine({
      sessions: [session(3005)],
      health: ['unreachable'],
    })
    expect(
      await waitForEngineReady(
        {
          providerId: 'llamacpp-upstream',
          modelId: 'm',
          serviceHub,
          timeoutMs: 20_000,
        },
        deps
      )
    ).toEqual({ ok: false, reason: 'timeout' })
    expect(calls.filter((c) => c === 'start')).toHaveLength(1)
  })

  it('reports a load that fails', async () => {
    const { deps } = fakeEngine({
      sessions: [null],
      start: () =>
        Promise.reject(new Error('Failed to load model: out of memory')),
    })
    expect(
      await waitForEngineReady(
        { providerId: 'llamacpp-upstream', modelId: 'm', serviceHub },
        deps
      )
    ).toEqual({
      ok: false,
      reason: 'start_failed',
      error: 'Failed to load model: out of memory',
    })
  })

  it('stops waiting when the user stops', async () => {
    const controller = new AbortController()
    const { deps } = fakeEngine({
      sessions: [null],
      start: () => {
        controller.abort()
        return new Promise(() => {})
      },
    })
    expect(
      await waitForEngineReady(
        {
          providerId: 'llamacpp-upstream',
          modelId: 'm',
          serviceHub,
          signal: controller.signal,
        },
        deps
      )
    ).toEqual({ ok: false, reason: 'aborted' })
  })

  it('does not try engines it cannot probe', async () => {
    const { deps, calls } = fakeEngine({ sessions: [session(1)] })
    expect(
      await waitForEngineReady(
        { providerId: 'openai', modelId: 'gpt', serviceHub },
        deps
      )
    ).toEqual({ ok: false, reason: 'unsupported' })
    expect(calls).toEqual([])
  })
})

describe('probeEngineHealth', () => {
  beforeEach(() => invokeMock.mockReset())

  it('probes /health on 127.0.0.1 with the session key', async () => {
    invokeMock.mockResolvedValue('{"status":"ok"}')
    expect(await probeEngineHealth({ port: 4321, api_key: 'secret' })).toBe(
      'ready'
    )
    expect(invokeMock).toHaveBeenCalledWith('get_local_http', {
      url: 'http://127.0.0.1:4321/health',
      headers: { Authorization: 'Bearer secret' },
      timeoutSecs: 3,
    })
  })

  it('tells loading, listening and gone apart', async () => {
    invokeMock.mockRejectedValueOnce(
      'HTTP 503: {"error":{"code":503,"message":"Loading model"}}'
    )
    expect(await probeEngineHealth({ port: 1, api_key: '' })).toBe('loading')
    invokeMock.mockRejectedValueOnce('HTTP 404: not found')
    expect(await probeEngineHealth({ port: 1, api_key: '' })).toBe('ready')
    invokeMock.mockRejectedValueOnce(
      'Request failed: error sending request (os error 10061)'
    )
    expect(await probeEngineHealth({ port: 1, api_key: '' })).toBe(
      'unreachable'
    )
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'

// The official IPC mock swallows `plugin:event|unlisten`, so the detach path
// can only be observed by stubbing the event module itself.
const listen = vi.fn()
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...args),
}))

const { TauriModelSetupService, CHANGED_EVENT, PROGRESS_EVENT, RESET_EVENT } =
  await import('../tauri')
const { DefaultModelSetupService } = await import('../default')
type ModelSetupEvent = import('../types').ModelSetupEvent

type Call = { method: string; path: string; body: unknown }

const record = { setup_id: 'a/b', revision: 1, stage: 'queued' }

describe('TauriModelSetupService commands', () => {
  let calls: Call[]

  beforeEach(() => {
    calls = []
    mockIPC((command: string, args?: InvokeArgs) => {
      expect(command).toBe('atomic_core_call')
      const call = args as Call
      calls.push(call)
      switch (`${call.method} ${call.path}`) {
        case 'POST /models/compatibility':
          return { outcome: 'engine_required', provider: 'atomic-prism' }
        case 'POST /models/setup-plan':
          return { digest: 'd' }
        case 'GET /models/atomic-prism/families':
          return { rules_version: 3, families: [] }
        case 'GET /model-setups':
          return { setups: [record] }
        case 'POST /model-setups':
        case 'POST /model-setups/a%2Fb/cancel':
        case 'POST /model-setups/a%2Fb/resume':
          return record
        default:
          throw new Error(`unexpected ${call.method} ${call.path}`)
      }
    })
  })

  it('asks the core for the Bonsai families the Hub lists', async () => {
    const service = new TauriModelSetupService()

    await expect(service.families()).resolves.toEqual({
      rules_version: 3,
      families: [],
    })
    expect(calls).toEqual([
      { method: 'GET', path: '/models/atomic-prism/families', body: null },
    ])
  })

  it('reaches the compatibility and setup routes with the bodies verbatim', async () => {
    const service = new TauriModelSetupService()
    const file = { repo: 'prism-ml/Bonsai', file: 'm.gguf' }
    const start = { ...file, request_id: 'r', plan_digest: 'd' }

    expect(service.isSupported()).toBe(true)
    expect(
      await service.checkCompatibility({
        ...file,
        provider: 'llamacpp-upstream',
      })
    ).toMatchObject({ outcome: 'engine_required' })
    expect(await service.plan(file)).toEqual({ digest: 'd' })
    expect(await service.start(start)).toEqual(record)
    expect(await service.list()).toEqual([record])
    await service.cancel('a/b')
    await service.resume('a/b')

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/models/compatibility',
        body: { ...file, provider: 'llamacpp-upstream' },
      },
      { method: 'POST', path: '/models/setup-plan', body: file },
      { method: 'POST', path: '/model-setups', body: start },
      { method: 'GET', path: '/model-setups', body: null },
      { method: 'POST', path: '/model-setups/a%2Fb/cancel', body: null },
      { method: 'POST', path: '/model-setups/a%2Fb/resume', body: null },
    ])
  })
})

describe('TauriModelSetupService.subscribe', () => {
  beforeEach(() => {
    // A bare `listen.mockReset()` would return the mock, which Vitest runs as
    // a cleanup callback — and a pending `listen()` promise then hangs the hook.
    listen.mockReset()
  })

  it('turns the relayed setup, download and snapshot events into setup events', async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>()
    listen.mockImplementation(
      async (name: string, handler: (event: { payload: unknown }) => void) => {
        handlers.set(name, handler)
        return () => {}
      }
    )
    const received: ModelSetupEvent[] = []
    new TauriModelSetupService().subscribe((event) => received.push(event))
    await Promise.resolve()

    expect([...handlers.keys()]).toEqual([
      CHANGED_EVENT,
      PROGRESS_EVENT,
      RESET_EVENT,
    ])
    handlers.get(CHANGED_EVENT)!({ payload: record })
    handlers.get(PROGRESS_EVENT)!({
      payload: { taskId: 't', transferred: 5, total: 10, percent: 50 },
    })
    handlers.get(PROGRESS_EVENT)!({ payload: { taskId: 'u' } })
    // A download event without a task id belongs to nothing it tracks.
    handlers.get(PROGRESS_EVENT)!({ payload: { transferred: 1 } })
    handlers.get(RESET_EVENT)!({ payload: { generation: 2 } })
    expect(received).toEqual([
      { type: 'changed', setup: record },
      { type: 'progress', taskId: 't', transferred: 5, total: 10 },
      { type: 'progress', taskId: 'u', transferred: 0, total: 0 },
      { type: 'reset' },
    ])
  })

  it('detaches each listener once, even when unsubscribed twice', async () => {
    const unlistens = [vi.fn(), vi.fn(), vi.fn()]
    let index = 0
    listen.mockImplementation(async () => unlistens[index++])

    const unsubscribe = new TauriModelSetupService().subscribe(() => {})
    unsubscribe()
    unsubscribe()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(unlistens.map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1])
  })
})

describe('DefaultModelSetupService', () => {
  it('is unsupported, rejects every call and subscribes to nothing', async () => {
    const service = new DefaultModelSetupService()
    const file = { repo: 'o/r', file: 'f.gguf' }
    expect(service.isSupported()).toBe(false)
    await expect(service.checkCompatibility(file)).rejects.toThrow(
      /not available/
    )
    await expect(service.plan(file)).rejects.toThrow(/not available/)
    await expect(
      service.start({ ...file, request_id: 'r', plan_digest: 'd' })
    ).rejects.toThrow(/not available/)
    await expect(service.list()).rejects.toThrow(/not available/)
    await expect(service.cancel('s')).rejects.toThrow(/not available/)
    await expect(service.resume('s')).rejects.toThrow(/not available/)
    expect(service.subscribe(() => {})()).toBeUndefined()
  })
})

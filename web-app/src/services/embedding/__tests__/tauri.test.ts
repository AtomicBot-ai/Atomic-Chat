import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'

// The official IPC mock swallows `plugin:event|unlisten`, so the detach path
// can only be observed by stubbing the event module itself.
const listen = vi.fn()
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...args),
}))

const { TauriEmbeddingService, STATE_EVENT, ERROR_EVENT, RESET_EVENT } =
  await import('../tauri')
const { DefaultEmbeddingService } = await import('../default')
type EmbeddingEvent = import('../types').EmbeddingEvent
type EmbeddingStatus = import('../types').EmbeddingStatus

const status: EmbeddingStatus = {
  state: 'ready',
  enabled: true,
  model_path:
    '/data/embedding/models/embeddinggemma-2/embeddinggemma-2-Q8_0.gguf',
  model_id: 'embeddinggemma-2',
  engine: {
    path: '/data/llamacpp/backends/b11454/macos-arm64/llama-server',
    version_backend: 'b11454/macos-arm64',
    provider: 'llamacpp-upstream',
  },
  pid: 42,
  port: 51000,
  dims: 768,
  modalities: ['text', 'image', 'audio'],
  restarts: 0,
  error: null,
  since: 1,
}

type Call = { method: string; path: string; body: unknown }

describe('TauriEmbeddingService commands', () => {
  let calls: Call[]

  beforeEach(() => {
    calls = []
    mockIPC((command: string, args?: InvokeArgs) => {
      expect(command).toBe('atomic_core_call')
      const call = args as Call
      calls.push(call)
      switch (`${call.method} ${call.path}`) {
        case 'GET /embedding/status':
        case 'POST /embedding/load':
        case 'POST /embedding/unload':
          return status
        case 'GET /embedding/config':
        case 'PUT /embedding/config':
          return { config: { enabled: true }, status }
        case 'POST /embedding/embed':
          return { status: 200, body: { object: 'list', data: [] } }
        default:
          throw new Error(`unexpected ${call.method} ${call.path}`)
      }
    })
  })

  it('reaches every control route under /embedding with snake_case bodies', async () => {
    const service = new TauriEmbeddingService()
    expect(service.isSupported()).toBe(true)
    expect(await service.getStatus()).toEqual(status)
    expect((await service.getConfig()).status).toEqual(status)
    await service.setConfig({
      enabled: true,
      model_path: 'embedding/models/bge-m3/bge-m3-q8_0.gguf',
      model_id: 'bge-m3',
      pooling: 'cls',
    })
    expect(await service.load()).toEqual(status)
    await service.unload()
    expect(await service.embed({ input: 'hello' })).toEqual({
      status: 200,
      body: { object: 'list', data: [] },
    })

    expect(calls).toEqual([
      { method: 'GET', path: '/embedding/status', body: null },
      { method: 'GET', path: '/embedding/config', body: null },
      {
        method: 'PUT',
        path: '/embedding/config',
        body: {
          enabled: true,
          model_path: 'embedding/models/bge-m3/bge-m3-q8_0.gguf',
          model_id: 'bge-m3',
          pooling: 'cls',
        },
      },
      { method: 'POST', path: '/embedding/load', body: null },
      { method: 'POST', path: '/embedding/unload', body: null },
      { method: 'POST', path: '/embedding/embed', body: { input: 'hello' } },
    ])
  })
})

describe('TauriEmbeddingService.subscribe', () => {
  beforeEach(() => {
    // A bare `listen.mockReset()` would return the mock, which Vitest runs as
    // a cleanup callback — and a pending `listen()` promise then hangs the hook.
    listen.mockReset()
  })

  it('turns the relayed state, error and snapshot events into embedding events', async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>()
    listen.mockImplementation(
      async (name: string, handler: (event: { payload: unknown }) => void) => {
        handlers.set(name, handler)
        return () => {}
      }
    )
    const received: EmbeddingEvent[] = []
    new TauriEmbeddingService().subscribe((event) => received.push(event))
    await Promise.resolve()

    expect([...handlers.keys()]).toEqual([
      STATE_EVENT,
      ERROR_EVENT,
      RESET_EVENT,
    ])
    expect(STATE_EVENT).toBe('atomic-core://embedding:state')
    expect(ERROR_EVENT).toBe('atomic-core://embedding:error')
    handlers.get(STATE_EVENT)!({ payload: status })
    handlers.get(ERROR_EVENT)!({
      payload: { code: 'MODEL_LOAD_FAILED', message: 'boom' },
    })
    handlers.get(RESET_EVENT)!({ payload: { generation: 2 } })
    expect(received).toEqual([
      { type: 'state', status },
      { type: 'error', error: { code: 'MODEL_LOAD_FAILED', message: 'boom' } },
      { type: 'reset' },
    ])
  })

  it('detaches each listener once, even when unsubscribed twice', async () => {
    const unlistens = [vi.fn(), vi.fn(), vi.fn()]
    let index = 0
    listen.mockImplementation(async () => unlistens[index++])

    const unsubscribe = new TauriEmbeddingService().subscribe(() => {})
    unsubscribe()
    unsubscribe()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(unlistens.map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1])
  })
})

describe('DefaultEmbeddingService', () => {
  it('is unsupported, rejects every call and subscribes to nothing', async () => {
    const service = new DefaultEmbeddingService()
    expect(service.isSupported()).toBe(false)
    await expect(service.getStatus()).rejects.toThrow(/not available/)
    await expect(service.getConfig()).rejects.toThrow(/not available/)
    await expect(service.setConfig({ enabled: false })).rejects.toThrow(
      /not available/
    )
    await expect(service.load()).rejects.toThrow(/not available/)
    await expect(service.unload()).rejects.toThrow(/not available/)
    await expect(service.embed({ input: 'x' })).rejects.toThrow(/not available/)
    expect(service.subscribe(() => {})()).toBeUndefined()
  })
})

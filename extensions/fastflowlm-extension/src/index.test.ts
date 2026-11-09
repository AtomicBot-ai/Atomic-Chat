import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, fs } = vi.hoisted(() => ({
  invoke: vi.fn(),
  fs: { existsSync: vi.fn(), readdirSync: vi.fn(), fileStat: vi.fn() },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))
vi.mock('@tauri-apps/plugin-log', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))
vi.mock('@janhq/core', () => ({
  AIEngine: class {
    onLoad() {}
    registerSettings() {}
    async getSettings() {
      return []
    }
    async updateSettings() {}
  },
  fs,
  getJanDataFolderPath: async () => '/data',
  joinPath: async (parts: string[]) => parts.join('/'),
}))
globalThis.SETTINGS = []
import FastFlowLmExtension from './index'

describe('FastFlowLM provider', () => {
  beforeEach(() => vi.clearAllMocks())

  it('offers an uninstalled engine when core registers it without probing readiness', async () => {
    invoke.mockImplementation(async (command, args) => {
      expect(command).toBe('atomic_core_call')
      expect(args).toEqual({
        method: 'POST',
        path: '/engines/versions',
        body: {},
      })
      return { engines: [{ engine: 'fastflowlm', active: null }] }
    })
    const engine = new FastFlowLmExtension()
    expect(engine.isHidden()).toBe(true)
    await expect(engine.refreshVisibility()).resolves.toBe(true)
    expect(engine.isHidden()).toBe(false)
  })

  it('coalesces list scans, ignores incomplete folders and reads no weight payload', async () => {
    const root = '/data/fastflowlm/models'
    fs.existsSync.mockImplementation(
      async (path: string) => !path.endsWith('partial/model.yml')
    )
    fs.readdirSync.mockResolvedValue([root + '/qwen3-06b', root + '/partial'])
    fs.fileStat.mockResolvedValue({ isDirectory: true })
    invoke.mockImplementation(async (command, args) => {
      if (command === 'atomic_core_call')
        return {
          verdict: 'ok',
          reason: null,
          metadata: {
            variant_id: 'qwen3-06b',
            capabilities: { chat: true, tools: true, reasoning: true },
          },
        }
      expect(command).toBe('read_yaml')
      expect(args.path).toBe(root + '/qwen3-06b/model.yml')
      return {
        name: 'Qwen3',
        size_bytes: 100,
        fastflowlm: {
          variant_id: 'qwen3-06b',
          capabilities: {
            chat: true,
            tools: true,
            reasoning: true,
            structured_output: false,
          },
        },
      }
    })
    const engine = new FastFlowLmExtension()
    const results = await Promise.all([engine.list(), engine.list()])
    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject([
      {
        id: 'qwen3-06b',
        providerId: 'fastflowlm',
        capabilities: ['tools', 'reasoning'],
      },
    ])
    expect(fs.readdirSync).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('does not offer a provider core did not register', async () => {
    invoke.mockResolvedValue({ engines: [] })
    const engine = new FastFlowLmExtension()
    await expect(engine.refreshVisibility()).resolves.toBe(false)
  })
  it('keeps a marker with missing files out of the ready model list', async () => {
    fs.existsSync.mockResolvedValue(true)
    fs.readdirSync.mockResolvedValue(['/data/fastflowlm/models/qwen3-06b'])
    fs.fileStat.mockResolvedValue({ isDirectory: true })
    invoke.mockImplementation(async (command) =>
      command === 'read_yaml'
        ? {
            fastflowlm: {
              variant_id: 'qwen3-06b',
              capabilities: { chat: true },
            },
          }
        : { verdict: 'invalid-installation', reason: 'Missing model.q4nx' }
    )
    await expect(new FastFlowLmExtension().list()).resolves.toEqual([])
  })
})

it('closes a streaming connection when the consumer leaves after its first chunk', async () => {
  invoke.mockResolvedValue({
    sessions: [
      {
        model_id: 'qwen',
        provider: 'fastflowlm',
        port: 4310,
        api_key: 'test-key',
      },
    ],
  })
  const cancel = vi.fn()
  const network = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"id":"chunk-1"}\n\n')
            )
          },
          cancel,
        })
      )
  )
  vi.stubGlobal('fetch', network)
  try {
    const engine = new FastFlowLmExtension()
    const chunks = (await engine.chat({
      model: 'qwen',
      stream: true,
      messages: [],
    } as never)) as AsyncIterable<{ id: string }>
    for await (const chunk of chunks) {
      expect(chunk.id).toBe('chunk-1')
      break
    }
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(network).toHaveBeenCalledTimes(1)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('waits for an invalidated scan before scanning again and never returns its stale result', async () => {
  const engine = new FastFlowLmExtension()
  let finish!: (models: unknown[]) => void
  const scan = vi
    .spyOn(engine as never, 'scanModels' as never)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce([{ id: 'fresh' }] as never)
  const first = engine.list()
  engine.invalidateModelList()
  const second = engine.list()
  expect(scan).toHaveBeenCalledTimes(1)
  finish([{ id: 'stale' }])
  expect(await first).toEqual([{ id: 'fresh' }])
  expect(await second).toEqual([{ id: 'fresh' }])
  expect(scan).toHaveBeenCalledTimes(2)
})

it('refreshes after an invalidated scan fails without overlapping scans', async () => {
  const engine = new FastFlowLmExtension()
  let fail!: (error: Error) => void
  const scan = vi
    .spyOn(engine as never, 'scanModels' as never)
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        })
    )
    .mockResolvedValueOnce([{ id: 'after-mutation' }] as never)
  const old = engine.list()
  engine.invalidateModelList()
  engine.invalidateModelList()
  const refreshed = engine.list()
  expect(scan).toHaveBeenCalledTimes(1)
  fail(new Error('The directory changed'))
  expect(await refreshed).toEqual([{ id: 'after-mutation' }])
  expect(await old).toEqual([{ id: 'after-mutation' }])
  expect(scan).toHaveBeenCalledTimes(2)
})

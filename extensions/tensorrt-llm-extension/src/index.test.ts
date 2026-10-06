import { beforeEach, describe, expect, it, vi } from 'vitest'

// The TensorRT-LLM runtime lives in `atomic-chat-core`: availability, loads, unloads, sessions and
// capabilities are control calls through `atomic_core_call`, and the model folders are read the
// way every engine extension reads its own. `invoke` answers only those, so any other command
// fails the test.

const { invokeMock, listenMock, fsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(async () => () => {}),
  fsMock: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    fileStat: vi.fn(),
    mkdir: vi.fn(),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('@tauri-apps/plugin-log', () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
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
  getJanDataFolderPath: vi.fn().mockResolvedValue('/data'),
  joinPath: vi.fn((parts: string[]) => Promise.resolve(parts.join('/'))),
  fs: fsMock,
}))

;(globalThis as { SETTINGS?: unknown }).SETTINGS = []

import TensorrtLlmExtension from './index'

type Route = (body: unknown) => unknown
function core(routes: Record<string, Route>, yaml: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'atomic_core_status')
      return { running: true, attached: { instance_id: 'i', generation: 1 } }
    if (command === 'read_yaml') {
      const path = String(args?.['path'])
      if (!(path in yaml)) throw new Error(`no yaml at ${path}`)
      return yaml[path]
    }
    if (command === 'atomic_core_call') {
      const call = {
        method: String(args?.['method']),
        path: String(args?.['path']),
        body: args?.['body'],
      }
      calls.push(call)
      const route = routes[`${call.method} ${call.path}`]
      if (!route) throw new Error(`unrouted ${call.method} ${call.path}`)
      return route(call.body)
    }
    throw new Error(`unexpected command: ${command}`)
  })
  return calls
}

const plan = (availability: string, reasons: string[] = []) => ({
  availability,
  descriptor_id: 'tensorrt-llm-1.2.1-r1',
  blockers: reasons.map((reason) => ({
    code: reason === 'descriptor-unavailable' ? 'MANAGED_METADATA_INVALID' : 'MANAGED_PREREQUISITE_BLOCKED',
    message: reason,
    reason,
  })),
})
const noEnvironments = { 'GET /environments': () => ({ environments: [] }) }

const containerSession = {
  pid: null,
  port: 4001,
  model_id: 'qwen3-8b',
  model_path: '/data/tensorrt-llm/models/qwen3-8b',
  is_embedding: false,
  api_key: 'gateway-key',
  execution: 'container',
  generation: 'g-1',
}

const handover = {
  'POST /settings/tensorrt-llm/import': () => ({
    status: 'imported',
    applied: [],
    conflicts: [],
    revision: 1,
  }),
  'GET /settings/tensorrt-llm': () => ({ provider: 'tensorrt-llm', revision: 2, values: {} }),
  'POST /settings/tensorrt-llm/acknowledge': () => ({}),
}

beforeEach(() => {
  invokeMock.mockReset()
  fsMock.existsSync.mockReset()
  fsMock.readdirSync.mockReset()
  fsMock.fileStat.mockReset()
  fsMock.mkdir.mockReset()
})

describe('availability', () => {
  it('asks the core with the engine id before anything is installed, and hides the provider without an NVIDIA GPU', async () => {
    const calls = core({
      ...noEnvironments,
      'POST /environments/probe': () => plan('prerequisite-blocked', ['no-gpu']),
    })
    const extension = new TensorrtLlmExtension()

    await extension.onLoad()
    // The probe onLoad started is the one a caller waits on: one probe, not two.
    await extension.refreshVisibility()

    expect(extension.isHidden()).toBe(true)
    expect(calls.filter((c) => c.path === '/environments/probe')).toHaveLength(1)
    expect(calls.find((c) => c.path === '/environments/probe')?.body).toEqual({
      descriptor_id: 'tensorrt-llm',
      target: { kind: 'runtime', installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' },
    })
  })

  it('does not hold the app start up waiting for the probe', async () => {
    // Every extension's onLoad is awaited before the UI renders, and a probe runs docker info,
    // nvidia-smi and a descriptor fetch.
    core({ ...noEnvironments, 'POST /environments/probe': () => new Promise(() => {}) })
    const extension = new TensorrtLlmExtension()

    await expect(extension.onLoad()).resolves.toBeUndefined()
    expect(extension.isHidden()).toBe(true)
  })

  it('shows the provider once the descriptor is published, on the next check', async () => {
    let answer = plan('prerequisite-blocked', ['descriptor-unavailable'])
    core({ ...noEnvironments, 'POST /environments/probe': () => answer })
    const extension = new TensorrtLlmExtension()
    await extension.onLoad()
    await extension.refreshVisibility()
    expect(extension.isHidden()).toBe(true)

    answer = plan('setup-required')

    await expect(extension.refreshVisibility()).resolves.toBe(true)
    expect(extension.isHidden()).toBe(false)
  })

  it('keeps a host with a blocker it can explain visible', async () => {
    core({
      ...noEnvironments,
      'POST /environments/probe': () => plan('prerequisite-blocked', ['compute-capability-too-low']),
    })
    const extension = new TensorrtLlmExtension()

    await expect(extension.refreshVisibility()).resolves.toBe(true)
  })

  it('hides the provider when the core cannot answer at all, and says it does not know', async () => {
    core({})
    const extension = new TensorrtLlmExtension()

    await expect(extension.refreshVisibility()).resolves.toBe(false)
    expect(extension.visibilityKnown()).toBe(false)
  })

  it('keeps its last answer through a probe that fails', async () => {
    let answer: () => unknown = () => plan('setup-required')
    core({ ...noEnvironments, 'POST /environments/probe': () => answer() })
    const extension = new TensorrtLlmExtension()
    await extension.refreshVisibility()

    answer = () => {
      throw new Error('core restarting')
    }

    await expect(extension.refreshVisibility()).resolves.toBe(true)
    expect(extension.visibilityKnown()).toBe(true)
  })
})

describe('models', () => {
  it('lists every folder with a model.yml, sized by its files, with tools only where the core says so', async () => {
    core(
      {
        'GET /models/tensorrt-llm/qwen3-8b/capabilities': () => ({ tools: true, reasoning: true }),
        'GET /models/tensorrt-llm/gemma/capabilities': () => ({ tools: false, reasoning: false }),
        // On Linux the core still names the data folder's own models folder.
        'GET /models/tensorrt-llm/location': () => ({ root: '/data/tensorrt-llm/models', free_bytes: 1 }),
      },
      {
        '/data/tensorrt-llm/models/qwen3-8b/model.yml': {
          repository: 'Qwen/Qwen3-8B',
          revision: 'abc',
          architectures: ['Qwen3ForCausalLM'],
          files: [
            { path: 'model-00001.safetensors', size: 1000, sha256: 'a' },
            { path: 'config.json', size: 24, sha256: null },
          ],
        },
        '/data/tensorrt-llm/models/gemma/model.yml': {
          repository: 'google/gemma',
          files: [],
        },
      }
    )
    const root = '/data/tensorrt-llm/models'
    // `partial` is a download in progress: files, no model.yml yet.
    fsMock.existsSync.mockImplementation(async (path: string) =>
      [root, `${root}/qwen3-8b/model.yml`, `${root}/gemma/model.yml`].includes(path)
    )
    fsMock.readdirSync.mockImplementation(async (path: string) =>
      path === root ? [`${root}/qwen3-8b`, `${root}/gemma`, `${root}/partial`] : []
    )
    fsMock.fileStat.mockResolvedValue({ isDirectory: true })
    const extension = new TensorrtLlmExtension()

    const models = await extension.list()

    expect(models.map((m) => m.id).sort()).toEqual(['gemma', 'qwen3-8b'])
    const qwen = models.find((m) => m.id === 'qwen3-8b')
    expect(qwen).toMatchObject({
      name: 'Qwen/Qwen3-8B',
      providerId: 'tensorrt-llm',
      sizeBytes: 1024,
      capabilities: ['tools'],
    })
    expect(models.find((m) => m.id === 'gemma')?.capabilities).toBeUndefined()
  })

  it('on Windows lists the models in the root the core names in its WSL distribution (change add-tensorrt-llm-windows)', async () => {
    const root = '//wsl.localhost/AtomicChat/var/lib/atomic-chat/scopes/k1/models/tensorrt-llm'
    core(
      {
        'GET /models/tensorrt-llm/location': () => ({ root, free_bytes: 1 }),
        'GET /models/tensorrt-llm/Qwen/Qwen3-8B/capabilities': () => ({ tools: true }),
      },
      { [`${root}/Qwen/Qwen3-8B/model.yml`]: { repository: 'Qwen/Qwen3-8B', files: [{ path: 'a', size: 5 }] } }
    )
    fsMock.existsSync.mockImplementation(async (path: string) =>
      [root, `${root}/Qwen/Qwen3-8B/model.yml`].includes(path)
    )
    fsMock.readdirSync.mockImplementation(async (path: string) =>
      path === root ? [`${root}/Qwen`] : path === `${root}/Qwen` ? [`${root}/Qwen/Qwen3-8B`] : []
    )
    fsMock.fileStat.mockResolvedValue({ isDirectory: true })

    const models = await new TensorrtLlmExtension().list()

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ id: 'Qwen/Qwen3-8B', sizeBytes: 5, path: `${root}/Qwen/Qwen3-8B` })
  })

  it('lists nothing, and reads no folder, before Atomic Chat’s distribution exists', async () => {
    core({
      'GET /models/tensorrt-llm/location': () => {
        throw { code: 'MANAGED_ADAPTER_UNAVAILABLE', message: 'The managed environment is not set up yet.' }
      },
    })

    await expect(new TensorrtLlmExtension().list()).resolves.toEqual([])
    expect(fsMock.existsSync).not.toHaveBeenCalled()
  })

  it('keeps listing the models it found when the core cannot answer for a moment', async () => {
    // Review finding: a core restarting must not make every model vanish.
    const root = '/data/tensorrt-llm/models'
    let reachable = true
    core(
      {
        'GET /models/tensorrt-llm/location': () => {
          if (!reachable) throw { code: 'CORE_NOT_RUNNING', message: 'The Atomic Chat core is not running.' }
          return { root, free_bytes: 1 }
        },
        'GET /models/tensorrt-llm/m/capabilities': () => ({ tools: false }),
      },
      { [`${root}/m/model.yml`]: { repository: 'org/m', files: [] } }
    )
    fsMock.existsSync.mockImplementation(async (path: string) => [root, `${root}/m/model.yml`].includes(path))
    fsMock.readdirSync.mockImplementation(async (path: string) => (path === root ? [`${root}/m`] : []))
    fsMock.fileStat.mockResolvedValue({ isDirectory: true })
    const extension = new TensorrtLlmExtension()
    expect((await extension.list()).map((m) => m.id)).toEqual(['m'])

    reachable = false

    expect((await extension.list()).map((m) => m.id)).toEqual(['m'])
    expect((await extension.get('m'))?.id).toBe('m')
  })

  it('answers tool support from the core, false when it cannot tell', async () => {
    core({
      'GET /models/tensorrt-llm/qwen3-8b/capabilities': () => ({ tools: true }),
    })
    const extension = new TensorrtLlmExtension()

    await expect(extension.isToolSupported('qwen3-8b')).resolves.toBe(true)
    await expect(extension.isToolSupported('gone')).resolves.toBe(false)
  })
})

describe('sessions', () => {
  it('hands the settings over, then loads through the core and returns its container session', async () => {
    const calls = core({
      ...handover,
      'POST /models/tensorrt-llm/qwen3-8b/load': () => ({ session: containerSession, created: true }),
    })
    const extension = new TensorrtLlmExtension()

    const session = await extension.load('qwen3-8b')

    expect(session).toMatchObject({ pid: null, port: 4001, api_key: 'gateway-key' })
    const paths = calls.map((c) => `${c.method} ${c.path}`)
    expect(paths.indexOf('POST /settings/tensorrt-llm/import')).toBeLessThan(
      paths.indexOf('POST /models/tensorrt-llm/qwen3-8b/load')
    )
  })

  it('reports the stages of its own load while the core starts the container, and stops listening after', async () => {
    // spec "Загрузка модели не выглядит как зависание".
    const handlers = new Map<string, (event: { payload: unknown }) => void>()
    const unlisten = vi.fn()
    listenMock.mockImplementation((async (name: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(name, handler)
      return unlisten
    }) as never)
    let finish!: (value: unknown) => void
    core({
      ...handover,
      'POST /models/tensorrt-llm/qwen3-8b/load': () => new Promise((resolve) => (finish = resolve)),
    })
    const extension = new TensorrtLlmExtension()
    const onStage = vi.fn()

    const loading = extension.load('qwen3-8b', undefined, false, false, { onStage })
    await vi.waitFor(() => expect(handlers.has('atomic-core://session:load-progress')).toBe(true))
    const emit = handlers.get('atomic-core://session:load-progress')!
    emit({ payload: { provider: 'tensorrt-llm', model_id: 'qwen3-8b', generation: 'g', stage: 'initializing-engine', elapsed_ms: 42000 } })
    emit({ payload: { provider: 'tensorrt-llm', model_id: 'other', generation: 'g', stage: 'ready', elapsed_ms: 1 } })
    emit({ payload: { provider: 'llamacpp', model_id: 'qwen3-8b', generation: 'g', stage: 'ready', elapsed_ms: 1 } })
    await vi.waitFor(() => expect(finish).toBeDefined())
    finish({ session: containerSession, created: true })
    await loading

    expect(onStage.mock.calls).toEqual([
      [{ kind: 'startingEngine', stage: 'initializing-engine', elapsedMs: 42000 }],
    ])
    expect(unlisten).toHaveBeenCalled()
  })

  it('reports only its own sessions as loaded', async () => {
    core({
      'GET /sessions': () => ({
        sessions: [
          { ...containerSession, provider: 'tensorrt-llm' },
          { ...containerSession, model_id: 'other', pid: 5, provider: 'llamacpp-upstream' },
        ],
      }),
    })

    await expect(new TensorrtLlmExtension().getLoadedModels()).resolves.toEqual(['qwen3-8b'])
  })

  describe('unload (task 3.14, F-9)', () => {
    const repoId = 'Qwen/Qwen3-1.7B'

    it('sends an id with `/` to the core as it is and reports stopped once the session is gone', async () => {
      let sessions = [{ ...containerSession, model_id: repoId, provider: 'tensorrt-llm' }]
      const calls = core({
        // The core matches the rest of the path; `Qwen%2FQwen3-1.7B` would be a no-op there.
        'POST /models/tensorrt-llm/Qwen/Qwen3-1.7B/unload': () => {
          sessions = []
          return { success: true }
        },
        'GET /sessions': () => ({ sessions }),
      })
      const extension = new TensorrtLlmExtension()

      await expect(extension.unload(repoId)).resolves.toEqual({ success: true })
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /models/tensorrt-llm/Qwen/Qwen3-1.7B/unload',
        'GET /sessions',
      ])
      await expect(extension.getLoadedModels()).resolves.toEqual([])
    })

    it("does not report stopped when the core answers success but still serves the model", async () => {
      core({
        'POST /models/tensorrt-llm/Qwen/Qwen3-1.7B/unload': () => ({ success: true }),
        'GET /sessions': () => ({
          sessions: [{ ...containerSession, model_id: repoId, provider: 'tensorrt-llm' }],
        }),
      })

      await expect(new TensorrtLlmExtension().unload(repoId)).resolves.toEqual({
        success: false,
        error: 'TensorRT-LLM model Qwen/Qwen3-1.7B is still loaded after the unload.',
      })
    })

    it('writes the call and its outcome to the app log', async () => {
      const log = await import('@tauri-apps/plugin-log')
      core({
        'POST /models/tensorrt-llm/Qwen/Qwen3-1.7B/unload': () => {
          throw { code: 'MODEL_NOT_FOUND', message: 'no such model' }
        },
      })

      await expect(new TensorrtLlmExtension().unload(repoId)).resolves.toEqual({
        success: false,
        error: 'no such model [MODEL_NOT_FOUND]',
      })
      expect(log.info).toHaveBeenCalledWith('[tensorrt-llm] unload Qwen/Qwen3-1.7B')
      expect(log.warn).toHaveBeenCalledWith(
        '[tensorrt-llm] unload Qwen/Qwen3-1.7B failed: no such model [MODEL_NOT_FOUND]'
      )
    })
  })

  describe('delete (task 3.15, core 2.24)', () => {
    const repoId = 'Qwen/Qwen3-1.7B'

    it('deletes through the core with the id as it is and reports the space freed', async () => {
      const calls = core({
        'DELETE /models/tensorrt-llm/Qwen/Qwen3-1.7B': () => ({
          model_id: repoId,
          was_loaded: true,
          freed_bytes: 4_100_000_000,
          engine_caches_removed: 2,
        }),
      })
      const extension = new TensorrtLlmExtension()

      await expect(extension.deleteWithReport(repoId)).resolves.toEqual({ freedBytes: 4_100_000_000 })
      await expect(extension.delete(repoId)).resolves.toBeUndefined()
      // The core stops the model and removes its folder and caches; the extension does nothing else.
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'DELETE /models/tensorrt-llm/Qwen/Qwen3-1.7B',
        'DELETE /models/tensorrt-llm/Qwen/Qwen3-1.7B',
      ])
      expect(fsMock.existsSync).not.toHaveBeenCalled()
    })

    it('says the files were not touched when the core could not confirm the stop', async () => {
      core({
        'DELETE /models/tensorrt-llm/Qwen/Qwen3-1.7B': () => {
          throw { code: 'MANAGED_STOP_UNCONFIRMED', message: 'Docker did not confirm the stop.' }
        },
      })

      await expect(new TensorrtLlmExtension().delete(repoId)).rejects.toMatchObject({
        code: 'MANAGED_STOP_UNCONFIRMED',
        message: 'TensorRT-LLM could not stop Qwen/Qwen3-1.7B, so its files were not touched. Try again, or check Docker.',
      })
    })

    it('fails, not succeeds, for a model the core does not have, and logs both ends', async () => {
      const log = await import('@tauri-apps/plugin-log')
      core({
        'DELETE /models/tensorrt-llm/Qwen/Qwen3-1.7B': () => {
          throw { code: 'MODEL_NOT_FOUND', message: 'Model not found' }
        },
      })

      const failure = new TensorrtLlmExtension().delete(repoId)
      await expect(failure).rejects.toBeInstanceOf(Error)
      await expect(failure).rejects.toMatchObject({
        code: 'MODEL_NOT_FOUND',
        message: 'TensorRT-LLM has no model Qwen/Qwen3-1.7B. It may have been deleted already.',
      })
      expect(log.info).toHaveBeenCalledWith('[tensorrt-llm] delete Qwen/Qwen3-1.7B')
      expect(log.warn).toHaveBeenCalledWith(
        '[tensorrt-llm] delete Qwen/Qwen3-1.7B failed: Model not found [MODEL_NOT_FOUND]'
      )
    })

    it('passes any other refusal on with the core\'s own words', async () => {
      core({
        'DELETE /models/tensorrt-llm/Qwen/Qwen3-1.7B': () => {
          throw { code: 'MANAGED_OPERATION_CONFLICT', message: 'The model is being deleted.' }
        },
      })

      await expect(new TensorrtLlmExtension().delete(repoId)).rejects.toThrow(
        'TensorRT-LLM could not delete Qwen/Qwen3-1.7B: The model is being deleted. [MANAGED_OPERATION_CONFLICT]'
      )
    })
  })

  it('chats through the session gateway with the session key', async () => {
    core({
      'GET /sessions': () => ({ sessions: [{ ...containerSession, provider: 'tensorrt-llm' }] }),
    })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'x', choices: [] }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const extension = new TensorrtLlmExtension()

    await extension.chat({ model: 'qwen3-8b', messages: [], stream: false } as never)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:4001/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gateway-key')
    vi.unstubAllGlobals()
  })
})

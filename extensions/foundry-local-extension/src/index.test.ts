import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Foundry Local provider lists `<data>/foundry-local/models/**/model.yml`, loads through the core
// and is shown only where the core registered the provider. `invoke` answers only the core calls and
// `read_yaml`, so any other command fails the test.

const { invokeMock, fsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  fsMock: { existsSync: vi.fn(), readdirSync: vi.fn(), fileStat: vi.fn(), rm: vi.fn() },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/plugin-log', () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@janhq/core', () => ({
  AIEngine: class AIEngine {
    registerSettings(_: unknown) {}
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

import FoundryLocalExtension from './index'

const ROOT = '/data/foundry-local/models'

function core(routes: Record<string, (body: unknown) => unknown>, yaml: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'read_yaml') {
      const path = String(args?.['path'])
      if (!(path in yaml)) throw new Error(`no yaml at ${path}`)
      return yaml[path]
    }
    if (command === 'atomic_core_status') return { attached: { instance_id: 'i', generation: 1 } }
    if (command === 'foundry_local_repair_chat_template') {
      calls.push({ method: 'REPAIR', path: String(args?.['modelId']), body: undefined })
      return false
    }
    if (command === 'atomic_core_call') {
      const call = { method: String(args?.['method']), path: String(args?.['path']), body: args?.['body'] }
      calls.push(call)
      const route = routes[`${call.method} ${call.path}`]
      if (!route) throw new Error(`unrouted ${call.method} ${call.path}`)
      return route(call.body)
    }
    throw new Error(`unexpected command: ${command}`)
  })
  return calls
}

/** A folder tree: each key a directory, its value the children (full paths). */
function tree(dirs: Record<string, string[]>, files: string[]) {
  fsMock.existsSync.mockImplementation(async (path: string) => path in dirs || files.includes(path))
  fsMock.readdirSync.mockImplementation(async (path: string) => dirs[path] ?? [])
  fsMock.fileStat.mockImplementation(async (path: string) => ({ isDirectory: path in dirs }))
}

const versions = (engines: string[]) => () => ({
  engines: engines.map((engine) => ({ engine })),
})

beforeEach(() => vi.clearAllMocks())

describe('the Foundry Local extension', () => {
  it('is the provider foundry-local', () => {
    const extension = new FoundryLocalExtension()
    expect(extension.provider).toBe('foundry-local')
    expect(extension.providerId).toBe('foundry-local')
  })

  it('stays hidden where the core did not register the provider (macOS 14, Intel Mac)', async () => {
    core({ 'POST /engines/versions': versions(['llamacpp-upstream', 'llamacpp', 'mlx']) })
    const extension = new FoundryLocalExtension()

    await expect(extension.refreshVisibility()).resolves.toBe(false)
    expect(extension.isHidden()).toBe(true)
    expect(extension.visibilityKnown()).toBe(true)
  })

  it('is shown where the core registered it, whatever the platform', async () => {
    core({ 'POST /engines/versions': versions(['llamacpp-upstream', 'mlx', 'foundry-local']) })
    const extension = new FoundryLocalExtension()

    await expect(extension.refreshVisibility()).resolves.toBe(true)
    expect(extension.isHidden()).toBe(false)
  })

  it('keeps its last answer while the core cannot say, and is hidden before any answer', async () => {
    let up = true
    core({
      'POST /engines/versions': () => {
        if (!up) throw { code: 'CORE_UNAVAILABLE', message: 'restarting' }
        return { engines: [{ engine: 'foundry-local' }] }
      },
    })
    const extension = new FoundryLocalExtension()
    expect(extension.isHidden()).toBe(true)
    expect(extension.visibilityKnown()).toBe(false)

    await extension.refreshVisibility()
    up = false
    await expect(extension.refreshVisibility()).resolves.toBe(true)
    expect(extension.isHidden()).toBe(false)
  })

  it('lists every variant folder with a model.yml and skips one without (a download in progress)', async () => {
    tree(
      {
        [ROOT]: [`${ROOT}/qwen3-4b-generic-gpu`, `${ROOT}/phi-4-mini-generic-cpu`],
        [`${ROOT}/qwen3-4b-generic-gpu`]: [],
        [`${ROOT}/phi-4-mini-generic-cpu`]: [`${ROOT}/phi-4-mini-generic-cpu/onnx`],
        [`${ROOT}/phi-4-mini-generic-cpu/onnx`]: [],
      },
      [`${ROOT}/qwen3-4b-generic-gpu/model.yml`]
    )
    core(
      {},
      {
        [`${ROOT}/qwen3-4b-generic-gpu/model.yml`]: {
          model_path: 'foundry-local/models/qwen3-4b-generic-gpu',
          name: 'Qwen3 4B (WebGPU)',
          size_bytes: 2_500_000_000,
          foundry_local: {
            model_id: 'qwen3-4b',
            variant_id: 'qwen3-4b-generic-gpu',
            execution_provider: 'webgpu',
            device: 'gpu',
            tools: true,
            reasoning: true,
          },
        },
      }
    )

    const models = await new FoundryLocalExtension().list()

    expect(models).toEqual([
      expect.objectContaining({
        id: 'qwen3-4b-generic-gpu',
        name: 'Qwen3 4B (WebGPU)',
        providerId: 'foundry-local',
        sizeBytes: 2_500_000_000,
        capabilities: ['tools', 'reasoning'],
        path: `${ROOT}/qwen3-4b-generic-gpu`,
      }),
    ])
  })

  it('declares no capability a variant does not, and never vision', async () => {
    tree({ [ROOT]: [`${ROOT}/phi`], [`${ROOT}/phi`]: [] }, [`${ROOT}/phi/model.yml`])
    core(
      {},
      {
        [`${ROOT}/phi/model.yml`]: {
          model_path: 'foundry-local/models/phi',
          name: 'Phi',
          size_bytes: 1,
          foundry_local: {
            model_id: 'phi',
            variant_id: 'phi',
            execution_provider: 'cpu',
            device: 'cpu',
            tools: false,
            reasoning: false,
          },
        },
      }
    )

    const [model] = await new FoundryLocalExtension().list()

    expect(model.capabilities).toBeUndefined()
  })

  it('skips a model.yml without its foundry_local block rather than failing the list', async () => {
    tree({ [ROOT]: [`${ROOT}/a`, `${ROOT}/b`], [`${ROOT}/a`]: [], [`${ROOT}/b`]: [] }, [
      `${ROOT}/a/model.yml`,
      `${ROOT}/b/model.yml`,
    ])
    core(
      {},
      {
        [`${ROOT}/a/model.yml`]: { model_path: 'foundry-local/models/a', name: 'A', size_bytes: 1 },
        [`${ROOT}/b/model.yml`]: {
          model_path: 'foundry-local/models/b',
          name: 'B',
          size_bytes: 1,
          foundry_local: {
            model_id: 'b',
            variant_id: 'b',
            execution_provider: 'cpu',
            device: 'cpu',
            tools: false,
            reasoning: false,
          },
        },
      }
    )

    const models = await new FoundryLocalExtension().list()

    expect(models.map((model) => model.id)).toEqual(['b'])
  })

  it('answers tool calling from the variant’s foundry_local block, false for an unknown model', async () => {
    core(
      {},
      {
        [`${ROOT}/q/model.yml`]: {
          model_path: 'foundry-local/models/q',
          name: 'Q',
          size_bytes: 1,
          foundry_local: {
            model_id: 'q',
            variant_id: 'q',
            execution_provider: 'cpu',
            device: 'cpu',
            tools: true,
            reasoning: false,
          },
        },
      }
    )
    const extension = new FoundryLocalExtension()

    await expect(extension.isToolSupported('q')).resolves.toBe(true)
    await expect(extension.isToolSupported('missing')).resolves.toBe(false)
  })

  it('lists nothing before the first download', async () => {
    tree({}, [])
    core({})
    await expect(new FoundryLocalExtension().list()).resolves.toEqual([])
  })

  it('loads through the core with the person’s settings handed over first, and returns the session', async () => {
    const calls = core({
      'POST /settings/foundry-local/import': () => ({ status: 'unchanged', applied: [], conflicts: [], revision: 3 }),
      'GET /settings/foundry-local': () => ({ provider: 'foundry-local', revision: 3, values: {} }),
      'POST /settings/foundry-local/acknowledge': () => ({}),
      'POST /models/foundry-local/qwen3-4b-generic-gpu/load': () => ({
        session: {
          pid: 4242,
          port: 41987,
          model_id: 'qwen3-4b-generic-gpu',
          model_path: '/data/foundry-local/models/qwen3-4b-generic-gpu',
          is_embedding: false,
          api_key: 'k',
        },
        created: true,
      }),
    })

    const session = await new FoundryLocalExtension().load('qwen3-4b-generic-gpu')

    expect(session).toMatchObject({ port: 41987, api_key: 'k', model_id: 'qwen3-4b-generic-gpu' })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /settings/foundry-local/import',
      'GET /settings/foundry-local',
      'POST /settings/foundry-local/acknowledge',
      // The template is made to take unwrapped tools before the host reads it.
      'REPAIR qwen3-4b-generic-gpu',
      'POST /models/foundry-local/qwen3-4b-generic-gpu/load',
    ])
  })

  it('keeps the core’s code when a load is refused, so the app can name the fix', async () => {
    core({
      'POST /settings/foundry-local/import': () => ({ status: 'unchanged', applied: [], conflicts: [], revision: 1 }),
      'GET /settings/foundry-local': () => ({ provider: 'foundry-local', revision: 1, values: {} }),
      'POST /settings/foundry-local/acknowledge': () => ({}),
      'POST /models/foundry-local/npu/load': () => {
        throw {
          code: 'FOUNDRY_LOCAL_ACCELERATOR_NOT_PREPARED',
          message: 'OpenVINOExecutionProvider is not prepared.',
        }
      },
    })

    await expect(new FoundryLocalExtension().load('npu')).rejects.toMatchObject({
      code: 'FOUNDRY_LOCAL_ACCELERATOR_NOT_PREPARED',
    })
  })

  it('deletes a variant’s folder whole, unloading it first, and says how much it freed', async () => {
    let loaded = true
    const calls = core(
      {
        'GET /sessions': () => ({
          sessions: loaded ? [{ provider: 'foundry-local', model_id: 'q', port: 1, pid: 2, api_key: 'k' }] : [],
        }),
        'POST /models/foundry-local/q/unload': () => {
          loaded = false
          return { success: true }
        },
      },
      { [`${ROOT}/q/model.yml`]: { model_path: 'foundry-local/models/q', name: 'Q', size_bytes: 4_000_000_000 } }
    )
    tree({ [ROOT]: [`${ROOT}/q`], [`${ROOT}/q`]: [] }, [`${ROOT}/q/model.yml`])

    const report = await new FoundryLocalExtension().deleteWithReport('q')

    expect(report).toEqual({ freedBytes: 4_000_000_000 })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /sessions',
      'POST /models/foundry-local/q/unload',
      'GET /sessions',
    ])
    expect(fsMock.rm).toHaveBeenCalledWith(`${ROOT}/q`)
  })

  it('touches no file when the loaded variant would not unload', async () => {
    core(
      {
        'GET /sessions': () => ({
          sessions: [{ provider: 'foundry-local', model_id: 'q', port: 1, pid: 2, api_key: 'k' }],
        }),
        'POST /models/foundry-local/q/unload': () => ({ success: false, error: 'host did not exit' }),
      },
      { [`${ROOT}/q/model.yml`]: { model_path: 'foundry-local/models/q', name: 'Q', size_bytes: 1 } }
    )
    tree({ [ROOT]: [`${ROOT}/q`], [`${ROOT}/q`]: [] }, [`${ROOT}/q/model.yml`])

    await expect(new FoundryLocalExtension().deleteWithReport('q')).rejects.toThrow(/could not stop q/)
    expect(fsMock.rm).not.toHaveBeenCalled()
  })

  it('does not report an unload the core still serves as done', async () => {
    core({
      'POST /models/foundry-local/q/unload': () => ({ success: true }),
      'GET /sessions': () => ({
        sessions: [{ provider: 'foundry-local', model_id: 'q', port: 1, pid: 2, api_key: 'k' }],
      }),
    })

    const result = await new FoundryLocalExtension().unload('q')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/still loaded/)
  })
})

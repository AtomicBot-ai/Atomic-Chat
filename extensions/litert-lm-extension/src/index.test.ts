import { beforeEach, describe, expect, it, vi } from 'vitest'

// The LiteRT-LM provider lists `<data>/litert-lm/models/*/model.yml`, loads through the core and is
// shown only where the core registered the provider. `invoke` answers only the core calls and
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

import LiteRtLmExtension from './index'

const ROOT = '/data/litert-lm/models'

function core(routes: Record<string, (body: unknown) => unknown>, yaml: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'read_yaml') {
      const path = String(args?.['path'])
      if (!(path in yaml)) throw new Error(`no yaml at ${path}`)
      return yaml[path]
    }
    if (command === 'atomic_core_status') return { attached: { instance_id: 'i', generation: 1 } }
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

/** A `litert_lm` block as the app's installer writes it (core `ModelYmlLiteRtLm`). */
const block = (overrides: Record<string, unknown> = {}) => ({
  model_id: 'gemma-4-e4b-it',
  variant_id: 'gemma-4-e4b-it-gpu',
  backend: 'gpu',
  repo: 'litert-community/gemma-4-E4B-it-litert-lm',
  revision: 'a'.repeat(40),
  file: 'gemma-4-E4B-it.litertlm',
  context_length: 32768,
  tools: true,
  reasoning: true,
  vision: true,
  source: 'curated',
  ...overrides,
})

beforeEach(() => vi.clearAllMocks())

describe('the LiteRT-LM extension', () => {
  it('is the provider litert-lm', () => {
    const extension = new LiteRtLmExtension()
    expect(extension.provider).toBe('litert-lm')
    expect(extension.providerId).toBe('litert-lm')
  })

  it('stays hidden where the core did not register the provider (Intel Mac, Windows on Arm)', async () => {
    core({ 'POST /engines/versions': versions(['llamacpp-upstream', 'llamacpp', 'foundry-local']) })
    const extension = new LiteRtLmExtension()

    await expect(extension.refreshVisibility()).resolves.toBe(false)
    expect(extension.isHidden()).toBe(true)
    expect(extension.visibilityKnown()).toBe(true)
  })

  it('is shown where the core registered it, whatever the platform', async () => {
    core({ 'POST /engines/versions': versions(['llamacpp-upstream', 'mlx', 'litert-lm']) })
    const extension = new LiteRtLmExtension()

    await expect(extension.refreshVisibility()).resolves.toBe(true)
    expect(extension.isHidden()).toBe(false)
  })

  it('keeps its last answer while the core cannot say, and is hidden before any answer', async () => {
    let up = true
    core({
      'POST /engines/versions': () => {
        if (!up) throw { code: 'CORE_UNAVAILABLE', message: 'restarting' }
        return { engines: [{ engine: 'litert-lm' }] }
      },
    })
    const extension = new LiteRtLmExtension()
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
        [ROOT]: [`${ROOT}/gemma-4-e4b-it-gpu`, `${ROOT}/qwen3-4b-cpu`],
        [`${ROOT}/gemma-4-e4b-it-gpu`]: [],
        [`${ROOT}/qwen3-4b-cpu`]: [],
      },
      [`${ROOT}/gemma-4-e4b-it-gpu/model.yml`, `${ROOT}/qwen3-4b-cpu/qwen3_4b.litertlm.part`]
    )
    core(
      {},
      {
        [`${ROOT}/gemma-4-e4b-it-gpu/model.yml`]: {
          model_path: 'litert-lm/models/gemma-4-e4b-it-gpu/gemma-4-E4B-it.litertlm',
          name: 'Gemma 4 E4B (GPU)',
          size_bytes: 3_650_000_000,
          litert_lm: block(),
        },
      }
    )

    const models = await new LiteRtLmExtension().list()

    expect(models).toEqual([
      expect.objectContaining({
        id: 'gemma-4-e4b-it-gpu',
        name: 'Gemma 4 E4B (GPU)',
        providerId: 'litert-lm',
        sizeBytes: 3_650_000_000,
        capabilities: ['tools', 'reasoning', 'vision'],
        path: `${ROOT}/gemma-4-e4b-it-gpu`,
      }),
    ])
  })

  it('declares no capability a variant does not', async () => {
    tree({ [ROOT]: [`${ROOT}/q`], [`${ROOT}/q`]: [] }, [`${ROOT}/q/model.yml`])
    core(
      {},
      {
        [`${ROOT}/q/model.yml`]: {
          model_path: 'litert-lm/models/q/q.litertlm',
          name: 'Q',
          size_bytes: 1,
          litert_lm: block({ variant_id: 'q', backend: 'cpu', tools: false, reasoning: false, vision: false }),
        },
      }
    )

    const [model] = await new LiteRtLmExtension().list()

    expect(model.capabilities).toBeUndefined()
  })

  it('skips a model.yml without its litert_lm block rather than failing the list', async () => {
    tree({ [ROOT]: [`${ROOT}/a`, `${ROOT}/b`], [`${ROOT}/a`]: [], [`${ROOT}/b`]: [] }, [
      `${ROOT}/a/model.yml`,
      `${ROOT}/b/model.yml`,
    ])
    core(
      {},
      {
        [`${ROOT}/a/model.yml`]: { model_path: 'litert-lm/models/a/a.litertlm', name: 'A', size_bytes: 1 },
        [`${ROOT}/b/model.yml`]: {
          model_path: 'litert-lm/models/b/b.litertlm',
          name: 'B',
          size_bytes: 1,
          litert_lm: block({ variant_id: 'b', backend: 'cpu' }),
        },
      }
    )

    const models = await new LiteRtLmExtension().list()

    expect(models.map((model) => model.id)).toEqual(['b'])
  })

  it('answers tool calling from the variant’s litert_lm block, false for an unknown model', async () => {
    core(
      {},
      {
        [`${ROOT}/q/model.yml`]: {
          model_path: 'litert-lm/models/q/q.litertlm',
          name: 'Q',
          size_bytes: 1,
          litert_lm: block({ variant_id: 'q', tools: true }),
        },
      }
    )
    const extension = new LiteRtLmExtension()

    await expect(extension.isToolSupported('q')).resolves.toBe(true)
    await expect(extension.isToolSupported('missing')).resolves.toBe(false)
  })

  it('lists nothing before the first download', async () => {
    tree({}, [])
    core({})
    await expect(new LiteRtLmExtension().list()).resolves.toEqual([])
  })

  it('loads through the core with the person’s settings handed over first, and returns the session', async () => {
    const calls = core({
      'POST /settings/litert-lm/import': () => ({ status: 'unchanged', applied: [], conflicts: [], revision: 3 }),
      'GET /settings/litert-lm': () => ({ provider: 'litert-lm', revision: 3, values: {} }),
      'POST /settings/litert-lm/acknowledge': () => ({}),
      'POST /models/litert-lm/gemma-4-e4b-it-gpu/load': () => ({
        session: {
          pid: 4242,
          port: 41987,
          model_id: 'gemma-4-e4b-it-gpu',
          model_path: '/data/litert-lm/models/gemma-4-e4b-it-gpu/gemma-4-E4B-it.litertlm',
          is_embedding: false,
          api_key: 'k',
        },
        created: true,
      }),
    })

    const session = await new LiteRtLmExtension().load('gemma-4-e4b-it-gpu')

    expect(session).toMatchObject({ port: 41987, api_key: 'k', model_id: 'gemma-4-e4b-it-gpu' })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /settings/litert-lm/import',
      'GET /settings/litert-lm',
      'POST /settings/litert-lm/acknowledge',
      'POST /models/litert-lm/gemma-4-e4b-it-gpu/load',
    ])
  })

  it('keeps the core’s code when a load is refused, so the app can name the fix', async () => {
    core({
      'POST /settings/litert-lm/import': () => ({ status: 'unchanged', applied: [], conflicts: [], revision: 1 }),
      'GET /settings/litert-lm': () => ({ provider: 'litert-lm', revision: 1, values: {} }),
      'POST /settings/litert-lm/acknowledge': () => ({}),
      'POST /models/litert-lm/npu/load': () => {
        throw { code: 'LITERT_LM_ACCELERATOR_NOT_PREPARED', message: 'OpenVINO is not prepared.' }
      },
    })

    await expect(new LiteRtLmExtension().load('npu')).rejects.toMatchObject({
      code: 'LITERT_LM_ACCELERATOR_NOT_PREPARED',
    })
  })

  it('deletes a variant’s folder whole, unloading it first, and says how much it freed', async () => {
    let loaded = true
    const calls = core(
      {
        'GET /sessions': () => ({
          sessions: loaded ? [{ provider: 'litert-lm', model_id: 'q', port: 1, pid: 2, api_key: 'k' }] : [],
        }),
        'POST /models/litert-lm/q/unload': () => {
          loaded = false
          return { success: true }
        },
      },
      { [`${ROOT}/q/model.yml`]: { model_path: 'litert-lm/models/q/q.litertlm', name: 'Q', size_bytes: 4_000_000_000 } }
    )
    tree({ [ROOT]: [`${ROOT}/q`], [`${ROOT}/q`]: [] }, [`${ROOT}/q/model.yml`])

    const report = await new LiteRtLmExtension().deleteWithReport('q')

    expect(report).toEqual({ freedBytes: 4_000_000_000 })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /sessions',
      'POST /models/litert-lm/q/unload',
      'GET /sessions',
    ])
    expect(fsMock.rm).toHaveBeenCalledWith(`${ROOT}/q`)
  })

  it('touches no file when the loaded variant would not unload', async () => {
    core(
      {
        'GET /sessions': () => ({
          sessions: [{ provider: 'litert-lm', model_id: 'q', port: 1, pid: 2, api_key: 'k' }],
        }),
        'POST /models/litert-lm/q/unload': () => ({ success: false, error: 'host did not exit' }),
      },
      { [`${ROOT}/q/model.yml`]: { model_path: 'litert-lm/models/q/q.litertlm', name: 'Q', size_bytes: 1 } }
    )
    tree({ [ROOT]: [`${ROOT}/q`], [`${ROOT}/q`]: [] }, [`${ROOT}/q/model.yml`])

    await expect(new LiteRtLmExtension().deleteWithReport('q')).rejects.toThrow(/could not stop q/)
    expect(fsMock.rm).not.toHaveBeenCalled()
  })

  it('does not report an unload the core still serves as done', async () => {
    core({
      'POST /models/litert-lm/q/unload': () => ({ success: true }),
      'GET /sessions': () => ({
        sessions: [{ provider: 'litert-lm', model_id: 'q', port: 1, pid: 2, api_key: 'k' }],
      }),
    })

    const result = await new LiteRtLmExtension().unload('q')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/still loaded/)
  })
})

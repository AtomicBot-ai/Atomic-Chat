import { beforeEach, describe, expect, it, vi } from 'vitest'

// The GenieX provider lists `<data>/geniex/models/*/model.yml`, loads through the core and is shown
// only where the core registered the provider (a Snapdragon X laptop). `invoke` answers only the
// core calls and `read_yaml`, so any other command fails the test.

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

import GeniexExtension from './index'

const ROOT = '/data/geniex/models'

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

/** A `geniex` block as the app's installer writes it for a GGUF (core `ModelYmlGeniex`). */
const gguf = (overrides: Record<string, unknown> = {}) => ({
  model_id: 'gemma-4-e4b',
  variant_id: 'gemma-4-e4b',
  plugin: 'llama_cpp',
  backend: 'npu',
  repo: 'google/gemma-4-E4B-it-qat-q4_0-gguf',
  revision: 'a'.repeat(40),
  file: 'gemma-4-E4B_q4_0-it.gguf',
  mmproj: 'gemma-4-E4B-it-mmproj.gguf',
  context_length: 32768,
  tools: true,
  reasoning: true,
  vision: true,
  source: 'curated',
  ...overrides,
})

/** The block for an AI Hub bundle: a chip, no file, NPU only. */
const bundle = (overrides: Record<string, unknown> = {}) => ({
  model_id: 'qwen3-4b-aihub',
  variant_id: 'qwen3-4b-aihub-x-elite',
  plugin: 'qairt',
  backend: 'npu',
  chip: 'x-elite',
  bundle_url: 'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/qwen3-4b.zip',
  precision: 'w4a16',
  context_length: 4096,
  tools: true,
  reasoning: false,
  vision: false,
  source: 'curated',
  ...overrides,
})

beforeEach(() => vi.clearAllMocks())

describe('the GenieX extension', () => {
  it('is the provider geniex', () => {
    const extension = new GeniexExtension()
    expect(extension.provider).toBe('geniex')
    expect(extension.providerId).toBe('geniex')
  })

  it('stays hidden where the core did not register the provider (Windows x64, a Mac)', async () => {
    // spec geniex-desktop "Windows x64": the app checks no platform itself.
    core({ 'POST /engines/versions': versions(['llamacpp-upstream', 'llamacpp', 'litert-lm']) })
    const extension = new GeniexExtension()

    await expect(extension.refreshVisibility()).resolves.toBe(false)
    expect(extension.isHidden()).toBe(true)
    expect(extension.visibilityKnown()).toBe(true)
  })

  it('is shown where the core registered it (a Snapdragon X laptop)', async () => {
    core({ 'POST /engines/versions': versions(['llamacpp-upstream', 'foundry-local', 'geniex']) })
    const extension = new GeniexExtension()

    await expect(extension.refreshVisibility()).resolves.toBe(true)
    expect(extension.isHidden()).toBe(false)
  })

  it('keeps its last answer while the core cannot say, and is hidden before any answer', async () => {
    let up = true
    core({
      'POST /engines/versions': () => {
        if (!up) throw { code: 'CORE_UNAVAILABLE', message: 'restarting' }
        return { engines: [{ engine: 'geniex' }] }
      },
    })
    const extension = new GeniexExtension()
    expect(extension.isHidden()).toBe(true)
    expect(extension.visibilityKnown()).toBe(false)

    await extension.refreshVisibility()
    up = false
    await expect(extension.refreshVisibility()).resolves.toBe(true)
    expect(extension.isHidden()).toBe(false)
  })

  it('lists every model folder with a model.yml and skips one without (a download in progress)', async () => {
    tree(
      {
        [ROOT]: [`${ROOT}/gemma-4-e4b`, `${ROOT}/qwen3-4b`],
        [`${ROOT}/gemma-4-e4b`]: [],
        [`${ROOT}/qwen3-4b`]: [],
      },
      [`${ROOT}/gemma-4-e4b/model.yml`, `${ROOT}/qwen3-4b/Qwen3-4B-Q4_0.gguf.tmp`]
    )
    core(
      {},
      {
        [`${ROOT}/gemma-4-e4b/model.yml`]: {
          model_path: 'geniex/models/gemma-4-e4b/gemma-4-E4B_q4_0-it.gguf',
          mmproj_path: 'geniex/models/gemma-4-e4b/gemma-4-E4B-it-mmproj.gguf',
          name: 'Gemma 4 E4B',
          size_bytes: 5_000_000_000,
          geniex: gguf(),
        },
      }
    )

    const models = await new GeniexExtension().list()

    expect(models).toEqual([
      expect.objectContaining({
        id: 'gemma-4-e4b',
        name: 'Gemma 4 E4B',
        providerId: 'geniex',
        sizeBytes: 5_000_000_000,
        capabilities: ['tools', 'reasoning', 'vision'],
        path: `${ROOT}/gemma-4-e4b`,
      }),
    ])
  })

  it('lists an AI Hub bundle by its variant folder, with the abilities its block declares', async () => {
    tree({ [ROOT]: [`${ROOT}/qwen3-4b-aihub-x-elite`], [`${ROOT}/qwen3-4b-aihub-x-elite`]: [] }, [
      `${ROOT}/qwen3-4b-aihub-x-elite/model.yml`,
    ])
    core(
      {},
      {
        [`${ROOT}/qwen3-4b-aihub-x-elite/model.yml`]: {
          model_path: 'geniex/models/qwen3-4b-aihub-x-elite',
          name: 'Qwen3 4B (AI Hub, X Elite)',
          size_bytes: 2_500_000_000,
          geniex: bundle(),
        },
      }
    )

    const [model] = await new GeniexExtension().list()

    expect(model).toEqual(
      expect.objectContaining({ id: 'qwen3-4b-aihub-x-elite', capabilities: ['tools'] })
    )
  })

  it('declares no capability a model does not', async () => {
    tree({ [ROOT]: [`${ROOT}/q`], [`${ROOT}/q`]: [] }, [`${ROOT}/q/model.yml`])
    core(
      {},
      {
        [`${ROOT}/q/model.yml`]: {
          model_path: 'geniex/models/q/q.gguf',
          name: 'Q',
          size_bytes: 1,
          geniex: gguf({ variant_id: 'q', tools: false, reasoning: false, vision: false }),
        },
      }
    )

    const [model] = await new GeniexExtension().list()

    expect(model.capabilities).toBeUndefined()
  })

  it('skips a model.yml without its geniex block rather than failing the list', async () => {
    tree({ [ROOT]: [`${ROOT}/a`, `${ROOT}/b`], [`${ROOT}/a`]: [], [`${ROOT}/b`]: [] }, [
      `${ROOT}/a/model.yml`,
      `${ROOT}/b/model.yml`,
    ])
    core(
      {},
      {
        [`${ROOT}/a/model.yml`]: { model_path: 'geniex/models/a/a.gguf', name: 'A', size_bytes: 1 },
        [`${ROOT}/b/model.yml`]: {
          model_path: 'geniex/models/b/b.gguf',
          name: 'B',
          size_bytes: 1,
          geniex: gguf({ variant_id: 'b', backend: 'cpu' }),
        },
      }
    )

    const models = await new GeniexExtension().list()

    expect(models.map((model) => model.id)).toEqual(['b'])
  })

  it('answers tool calling from the geniex block, false for an unknown model', async () => {
    core(
      {},
      {
        [`${ROOT}/q/model.yml`]: {
          model_path: 'geniex/models/q/q.gguf',
          name: 'Q',
          size_bytes: 1,
          geniex: gguf({ variant_id: 'q', tools: true }),
        },
      }
    )
    const extension = new GeniexExtension()

    await expect(extension.isToolSupported('q')).resolves.toBe(true)
    await expect(extension.isToolSupported('missing')).resolves.toBe(false)
  })

  it('lists nothing before the first download', async () => {
    tree({}, [])
    core({})
    await expect(new GeniexExtension().list()).resolves.toEqual([])
  })

  it('loads through the core with the person’s settings handed over first, and returns the session', async () => {
    const calls = core({
      'POST /settings/geniex/import': () => ({ status: 'unchanged', applied: [], conflicts: [], revision: 3 }),
      'GET /settings/geniex': () => ({ provider: 'geniex', revision: 3, values: {} }),
      'POST /settings/geniex/acknowledge': () => ({}),
      'POST /models/geniex/gemma-4-e4b/load': () => ({
        session: {
          pid: 4242,
          port: 41987,
          model_id: 'gemma-4-e4b',
          model_path: '/data/geniex/models/gemma-4-e4b/gemma-4-E4B_q4_0-it.gguf',
          is_embedding: false,
          api_key: 'k',
        },
        created: true,
      }),
    })

    const session = await new GeniexExtension().load('gemma-4-e4b')

    expect(session).toMatchObject({ port: 41987, api_key: 'k', model_id: 'gemma-4-e4b' })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /settings/geniex/import',
      'GET /settings/geniex',
      'POST /settings/geniex/acknowledge',
      'POST /models/geniex/gemma-4-e4b/load',
    ])
  })

  it('keeps the core’s code when a load is refused, so the app can name the fix', async () => {
    // spec geniex-runtime "Бандл на другом устройстве".
    core({
      'POST /settings/geniex/import': () => ({ status: 'unchanged', applied: [], conflicts: [], revision: 1 }),
      'GET /settings/geniex': () => ({ provider: 'geniex', revision: 1, values: {} }),
      'POST /settings/geniex/acknowledge': () => ({}),
      'POST /models/geniex/bundle/load': () => {
        throw { code: 'GENIEX_VARIANT_UNSUPPORTED', message: 'AI Hub bundles run on the NPU only.' }
      },
    })

    await expect(new GeniexExtension().load('bundle')).rejects.toMatchObject({
      code: 'GENIEX_VARIANT_UNSUPPORTED',
    })
  })

  it('deletes a model’s folder whole, unloading it first, and says how much it freed', async () => {
    // spec geniex-models "Удаление модели SHALL удалять папку целиком".
    let loaded = true
    const calls = core(
      {
        'GET /sessions': () => ({
          sessions: loaded ? [{ provider: 'geniex', model_id: 'q', port: 1, pid: 2, api_key: 'k' }] : [],
        }),
        'POST /models/geniex/q/unload': () => {
          loaded = false
          return { success: true }
        },
      },
      { [`${ROOT}/q/model.yml`]: { model_path: 'geniex/models/q/q.gguf', name: 'Q', size_bytes: 4_000_000_000 } }
    )
    tree({ [ROOT]: [`${ROOT}/q`], [`${ROOT}/q`]: [] }, [`${ROOT}/q/model.yml`])

    const report = await new GeniexExtension().deleteWithReport('q')

    expect(report).toEqual({ freedBytes: 4_000_000_000 })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /sessions',
      'POST /models/geniex/q/unload',
      'GET /sessions',
    ])
    expect(fsMock.rm).toHaveBeenCalledWith(`${ROOT}/q`)
  })

  it('touches no file when the loaded model would not unload', async () => {
    core(
      {
        'GET /sessions': () => ({
          sessions: [{ provider: 'geniex', model_id: 'q', port: 1, pid: 2, api_key: 'k' }],
        }),
        'POST /models/geniex/q/unload': () => ({ success: false, error: 'host did not exit' }),
      },
      { [`${ROOT}/q/model.yml`]: { model_path: 'geniex/models/q/q.gguf', name: 'Q', size_bytes: 1 } }
    )
    tree({ [ROOT]: [`${ROOT}/q`], [`${ROOT}/q`]: [] }, [`${ROOT}/q/model.yml`])

    await expect(new GeniexExtension().deleteWithReport('q')).rejects.toThrow(/could not stop q/)
    expect(fsMock.rm).not.toHaveBeenCalled()
  })

  it('does not report an unload the core still serves as done', async () => {
    core({
      'POST /models/geniex/q/unload': () => ({ success: true }),
      'GET /sessions': () => ({
        sessions: [{ provider: 'geniex', model_id: 'q', port: 1, pid: 2, api_key: 'k' }],
      }),
    })

    const result = await new GeniexExtension().unload('q')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/still loaded/)
  })
})

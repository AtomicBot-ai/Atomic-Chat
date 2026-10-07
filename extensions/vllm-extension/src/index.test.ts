import { beforeEach, describe, expect, it, vi } from 'vitest'

// The vLLM provider is the shared managed-engine extension under its own engine id: everything it
// asks the core is about `vllm`, and its models are the shared store's. `invoke` answers only the
// core calls and `read_yaml`, so any other command fails the test.

const { invokeMock, fsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  fsMock: { existsSync: vi.fn(), readdirSync: vi.fn(), fileStat: vi.fn() },
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

import VllmExtension from './index'

function core(routes: Record<string, (body: unknown) => unknown>, yaml: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'read_yaml') {
      const path = String(args?.['path'])
      if (!(path in yaml)) throw new Error(`no yaml at ${path}`)
      return yaml[path]
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

beforeEach(() => vi.clearAllMocks())

describe('the vLLM extension', () => {
  it('is the provider vllm and asks the core about vLLM only, with its own installed descriptor', async () => {
    const calls = core({
      'GET /environments': () => ({
        environments: [
          {
            installations: [
              { engine_id: 'tensorrt-llm', active_descriptor_id: 'tensorrt-llm-1.3.0rc29-r3' },
              { engine_id: 'vllm', active_descriptor_id: 'vllm-0.31.0-cu129-r1' },
            ],
          },
        ],
      }),
      'POST /environments/probe': () => ({ availability: 'supported', blockers: [] }),
    })
    const extension = new VllmExtension()

    expect(extension.provider).toBe('vllm')
    await expect(extension.refreshVisibility()).resolves.toBe(true)
    expect(calls[1].body).toEqual({
      descriptor_id: 'vllm-0.31.0-cu129-r1',
      target: { kind: 'runtime', installation_id: 'vllm', engine_id: 'vllm' },
    })
  })

  it('stays hidden while conf has not published its descriptor (design D15)', async () => {
    core({
      'GET /environments': () => ({ environments: [] }),
      'POST /environments/probe': () => ({
        availability: 'prerequisite-blocked',
        blockers: [{ code: 'MANAGED_METADATA_INVALID', message: 'no descriptor', reason: 'descriptor-unavailable' }],
      }),
    })
    const extension = new VllmExtension()

    await expect(extension.refreshVisibility()).resolves.toBe(false)
    expect(extension.isHidden()).toBe(true)
  })

  it('lists the shared store, with tools as the core says for vLLM', async () => {
    const root = '/data/managed-models'
    core(
      {
        'GET /managed-models/location': () => ({ root, free_bytes: 1 }),
        'GET /models/vllm/Qwen/Qwen3-8B-AWQ/capabilities': () => ({ tools: true }),
      },
      { [`${root}/Qwen/Qwen3-8B-AWQ/model.yml`]: { repository: 'Qwen/Qwen3-8B-AWQ', files: [{ path: 'a', size: 7 }] } }
    )
    fsMock.existsSync.mockImplementation(async (path: string) =>
      [root, `${root}/Qwen/Qwen3-8B-AWQ/model.yml`].includes(path)
    )
    fsMock.readdirSync.mockImplementation(async (path: string) =>
      path === root ? [`${root}/Qwen`] : path === `${root}/Qwen` ? [`${root}/Qwen/Qwen3-8B-AWQ`] : []
    )
    fsMock.fileStat.mockResolvedValue({ isDirectory: true })

    const models = await new VllmExtension().list()

    expect(models).toEqual([
      expect.objectContaining({ id: 'Qwen/Qwen3-8B-AWQ', providerId: 'vllm', sizeBytes: 7, capabilities: ['tools'] }),
    ])
  })

  it('deletes through the store route and names itself when the core cannot stop the model', async () => {
    const calls = core({
      'DELETE /managed-models/Qwen/Qwen3-8B-AWQ': () => {
        throw { code: 'MANAGED_STOP_UNCONFIRMED', message: 'Docker did not confirm the stop.' }
      },
    })

    await expect(new VllmExtension().delete('Qwen/Qwen3-8B-AWQ')).rejects.toMatchObject({
      code: 'MANAGED_STOP_UNCONFIRMED',
      message: 'vLLM could not stop Qwen/Qwen3-8B-AWQ, so its files were not touched. Try again, or check Docker.',
    })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['DELETE /managed-models/Qwen/Qwen3-8B-AWQ'])
  })
})

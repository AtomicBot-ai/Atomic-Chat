import { describe, expect, it, vi } from 'vitest'

import {
  fetchFoundryLocalList,
  parseFoundryLocalList,
  type FoundryLocalListCache,
} from '../curated'

const SHA = 'a'.repeat(64)

const variant = (extra: Record<string, unknown> = {}) => ({
  id: 'qwen2.5-7b-instruct-openvino-npu',
  device: 'npu',
  execution_provider: 'openvino',
  platforms: ['win-x64'],
  source: {
    kind: 'azureml',
    asset_id: 'azureml://registries/azureml/models/qwen2.5-7b-instruct-openvino-npu/versions/5',
    version: '5',
    path_prefix: 'v5',
  },
  files: [{ path: 'model.onnx', size: 10, sha256: SHA }],
  ...extra,
})

const model = (variants: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'qwen2.5-7b-instruct',
  name: 'Qwen2.5 7B Instruct',
  description: 'Chat model',
  task: 'chat',
  license: 'apache-2.0',
  context_length: 32768,
  tools: true,
  reasoning: false,
  variants,
  ...extra,
})

const list = (models: unknown[], extra: Record<string, unknown> = {}) => ({
  schema_version: 1,
  updated_at: '2026-10-15T00:00:00Z',
  resolver: {
    url_template:
      'https://{region}.api.azureml.ms/modelregistry/v1.0/registry/models/nonazureaccount?assetId={asset_id}',
    regions: ['eastus', 'westeurope'],
  },
  catalog: { url: 'https://api.catalog.azureml.ms/asset-gallery/v1.0/models' },
  models,
  ...extra,
})

describe('parseFoundryLocalList', () => {
  it('accepts an empty model list: the Hub then shows the Microsoft catalog only', () => {
    const parsed = parseFoundryLocalList(list([]))
    expect(parsed.models).toEqual([])
    expect(parsed.resolver.regions).toEqual(['eastus', 'westeurope'])
    expect(parsed.catalog.url).toBe('https://api.catalog.azureml.ms/asset-gallery/v1.0/models')
  })

  it('hides a variant with a source kind it does not know and keeps the model with its azureml ones', () => {
    // spec "Новый вид источника": a released app knows only `azureml`.
    const parsed = parseFoundryLocalList(
      list([
        model([
          variant(),
          variant({ id: 'qwen2.5-7b-instruct-hf', source: { kind: 'hf', repo: 'Qwen/x', revision: 'abc' } }),
        ]),
      ])
    )
    expect(parsed.models).toHaveLength(1)
    expect(parsed.models[0].variants.map((v) => v.id)).toEqual(['qwen2.5-7b-instruct-openvino-npu'])
  })

  it('hides variants with an accelerator or a device it does not know', () => {
    const parsed = parseFoundryLocalList(
      list([
        model([
          variant(),
          variant({ id: 'a', execution_provider: 'tensorrt-rtx' }),
          variant({ id: 'b', device: 'tpu' }),
        ]),
      ])
    )
    expect(parsed.models[0].variants.map((v) => v.id)).toEqual(['qwen2.5-7b-instruct-openvino-npu'])
  })

  it('drops a model left with no variant, not the whole list', () => {
    const parsed = parseFoundryLocalList(
      list([
        model([variant({ source: { kind: 'hf' } })], { id: 'only-hf' }),
        model([variant()], { id: 'kept' }),
      ])
    )
    expect(parsed.models.map((m) => m.id)).toEqual(['kept'])
  })

  it('refuses a document with a newer schema_version', () => {
    expect(() => parseFoundryLocalList(list([], { schema_version: 2 }))).toThrow(/schema_version/)
  })

  it('keeps a variant’s own context length when it is smaller than the model’s', () => {
    const parsed = parseFoundryLocalList(list([model([variant({ context_length: 4096 }), variant({ id: 'cpu', device: 'cpu', execution_provider: 'cpu' })])]))
    const [npu, cpu] = parsed.models[0].variants
    expect(npu.context_length).toBe(4096)
    expect(cpu.context_length).toBeUndefined()
  })

  it('hides a variant whose file would climb out of its folder or lacks a sha256', () => {
    const parsed = parseFoundryLocalList(
      list([
        model([
          variant(),
          variant({ id: 'escape', files: [{ path: '../x.onnx', size: 1, sha256: SHA }] }),
          variant({ id: 'unhashed', files: [{ path: 'model.onnx', size: 1 }] }),
        ]),
      ])
    )
    expect(parsed.models[0].variants.map((v) => v.id)).toEqual(['qwen2.5-7b-instruct-openvino-npu'])
  })

  it('refuses a document without a resolver it can use', () => {
    expect(() =>
      parseFoundryLocalList(list([], { resolver: { url_template: 'https://x/{asset_id}', regions: ['eastus'] } }))
    ).toThrow(/resolver/)
  })
})

describe('fetchFoundryLocalList', () => {
  const memoryCache = (initial: { value: unknown; fetchedAt: number } | null = null) => {
    let entry = initial
    const cache: FoundryLocalListCache = {
      read: async () => entry,
      write: async (value, fetchedAt) => {
        entry = { value, fetchedAt }
      },
    }
    return { cache, current: () => entry }
  }

  it('uses a fresh cache without asking the network', async () => {
    const { cache } = memoryCache({ value: list([]), fetchedAt: Date.now() })
    const fetchJson = vi.fn()

    const result = await fetchFoundryLocalList({ cache, fetchJson })

    expect(result.source).toBe('cache')
    expect(fetchJson).not.toHaveBeenCalled()
  })

  it('keeps the last accepted list when main carries a newer schema_version', async () => {
    const accepted = list([model([variant()])])
    const { cache, current } = memoryCache({ value: accepted, fetchedAt: 0 })

    const result = await fetchFoundryLocalList({
      cache,
      fetchJson: async () => list([], { schema_version: 2 }),
    })

    expect(result.source).toBe('cache')
    expect(result.list?.models.map((m) => m.id)).toEqual(['qwen2.5-7b-instruct'])
    expect(result.error).toMatch(/schema_version/)
    expect(current()?.value).toEqual(accepted)
  })

  it('stores what the network answered and returns it', async () => {
    const { cache, current } = memoryCache()

    const result = await fetchFoundryLocalList({ cache, fetchJson: async () => list([model([variant()])]) })

    expect(result.source).toBe('remote')
    expect(result.list?.models).toHaveLength(1)
    expect(current()).not.toBeNull()
  })

  it('falls back to the bundled resolver and catalog when there is nothing else', async () => {
    const { cache } = memoryCache()

    const result = await fetchFoundryLocalList({
      cache,
      fetchJson: async () => {
        throw new Error('offline')
      },
    })

    expect(result.source).toBe('baseline')
    expect(result.list?.models).toEqual([])
    expect(result.list?.resolver.url_template).toContain('{asset_id}')
    expect(result.error).toBe('offline')
  })
})

import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_GENIEX_MODELS_URL,
  fetchGeniexList,
  parseGeniexList,
  type GeniexListCache,
} from '../curated'

const SHA = 'a'.repeat(64)
const REVISION = 'b'.repeat(40)
const BUNDLE_URL = 'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/qwen3-4b/x-elite.zip'

const gguf = (extra: Record<string, unknown> = {}) => ({
  id: 'qwen3-4b',
  name: 'Qwen3 4B',
  description: 'Qwen3 4B, Q4_0',
  task: 'chat',
  license: 'apache-2.0',
  context_length: 32768,
  tools: true,
  reasoning: true,
  vision: false,
  kind: 'gguf',
  repo: 'unsloth/Qwen3-4B-GGUF',
  revision: REVISION,
  gated: false,
  file: { path: 'Qwen3-4B-Q4_0.gguf', size: 2_375_773_472, sha256: SHA },
  devices: ['npu', 'gpu', 'cpu', 'hybrid'],
  platforms: ['win-arm64'],
  ...extra,
})

const variant = (extra: Record<string, unknown> = {}) => ({
  id: 'qwen3-4b-aihub-x-elite',
  chip: 'x-elite',
  bundle: { url: BUNDLE_URL, size: 2_500_000_000, sha256: SHA },
  precision: 'w4a16',
  ...extra,
})

const qairt = (variants: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'qwen3-4b-aihub',
  name: 'Qwen3 4B (AI Hub)',
  description: 'Compiled by Qualcomm AI Hub',
  task: 'chat',
  license: 'apache-2.0',
  context_length: 4096,
  tools: true,
  reasoning: false,
  vision: false,
  kind: 'qairt',
  variants,
  ...extra,
})

const list = (models: unknown[], extra: Record<string, unknown> = {}) => ({
  schema_version: 1,
  updated_at: '2026-10-27T00:00:00Z',
  huggingface: {
    quantizations: ['Q4_0'],
    backends: { 'win-arm64': ['npu', 'gpu', 'cpu', 'hybrid'] },
  },
  models,
  ...extra,
})

const memoryCache = (entry: { value: unknown; fetchedAt: number } | null = null): GeniexListCache & {
  entry: { value: unknown; fetchedAt: number } | null
} => {
  const cache = {
    entry,
    read: async () => cache.entry,
    write: async (value: unknown, fetchedAt: number) => {
      cache.entry = { value, fetchedAt }
    },
  }
  return cache
}

describe('parseGeniexList', () => {
  it('accepts an empty model list: the Hub then shows Hugging Face GGUF models only, and no bundles', () => {
    const parsed = parseGeniexList(list([]))
    expect(parsed.models).toEqual([])
    expect(parsed.huggingface).toEqual({
      quantizations: ['Q4_0'],
      backends: { 'win-arm64': ['npu', 'gpu', 'cpu', 'hybrid'] },
    })
  })

  it('reads a GGUF model with its file, projector and devices, and a bundle model with its variants', () => {
    const parsed = parseGeniexList(
      list([
        gguf({ vision: true, mmproj: { path: 'mmproj-F16.gguf', size: 9, sha256: SHA } }),
        qairt([variant(), variant({ id: 'qwen3-4b-aihub-x2-elite', chip: 'x2-elite', min_runtime_version: '0.9.3' })]),
      ])
    )
    expect(parsed.models).toHaveLength(2)
    expect(parsed.models[0]).toMatchObject({
      kind: 'gguf',
      id: 'qwen3-4b',
      gguf: { repo: 'unsloth/Qwen3-4B-GGUF', mmproj: { path: 'mmproj-F16.gguf' }, devices: ['npu', 'gpu', 'cpu', 'hybrid'] },
    })
    expect(parsed.models[1]).toMatchObject({ kind: 'qairt', id: 'qwen3-4b-aihub' })
    expect(parsed.models[1].kind === 'qairt' && parsed.models[1].variants).toEqual([
      expect.objectContaining({ id: 'qwen3-4b-aihub-x-elite', chip: 'x-elite' }),
      expect.objectContaining({ id: 'qwen3-4b-aihub-x2-elite', chip: 'x2-elite', min_runtime_version: '0.9.3' }),
    ])
  })

  it('hides a model of a kind it does not know, not the whole list', () => {
    // spec geniex-models "Клиент пропускает то, чего не понимает".
    const parsed = parseGeniexList(list([gguf(), { ...gguf({ id: 'onnx' }), kind: 'onnx' }]))
    expect(parsed.models.map((m) => m.id)).toEqual(['qwen3-4b'])
  })

  it('hides a bundle variant with a chip it does not know and keeps the model with the others', () => {
    // spec geniex-models "Новый чип".
    const parsed = parseGeniexList(
      list([qairt([variant(), variant({ id: 'qwen3-4b-aihub-x3-elite', chip: 'x3-elite' })])])
    )
    const model = parsed.models[0]
    expect(model.kind === 'qairt' && model.variants.map((v) => v.id)).toEqual(['qwen3-4b-aihub-x-elite'])
  })

  it('drops a bundle model left with no variant, not the whole list', () => {
    const parsed = parseGeniexList(list([qairt([variant({ chip: 'x3-elite' })]), gguf()]))
    expect(parsed.models.map((m) => m.id)).toEqual(['qwen3-4b'])
  })

  it('leaves out a device it does not know, and hides a GGUF model left with none', () => {
    const parsed = parseGeniexList(
      list([gguf({ devices: ['npu', 'tpu'] }), gguf({ id: 'tpu-only', devices: ['tpu'] })])
    )
    expect(parsed.models.map((m) => m.id)).toEqual(['qwen3-4b'])
    const model = parsed.models[0]
    expect(model.kind === 'gguf' && model.gguf.devices).toEqual(['npu'])
  })

  it('leaves out a platform it does not know, and hides a GGUF model left with none', () => {
    const parsed = parseGeniexList(
      list([gguf({ platforms: ['win-arm64', 'linux-arm64'] }), gguf({ id: 'linux', platforms: ['linux-arm64'] })])
    )
    expect(parsed.models.map((m) => m.id)).toEqual(['qwen3-4b'])
  })

  it('hides a GGUF model whose file would climb out of its folder, lacks a sha256 or is not a GGUF, and a vision model without a projector', () => {
    const parsed = parseGeniexList(
      list([
        gguf(),
        gguf({ id: 'escape', file: { path: '../x.gguf', size: 1, sha256: SHA } }),
        gguf({ id: 'unhashed', file: { path: 'x.gguf', size: 1 } }),
        gguf({ id: 'not-gguf', file: { path: 'x.task', size: 1, sha256: SHA } }),
        gguf({ id: 'blind', vision: true }),
      ])
    )
    expect(parsed.models.map((m) => m.id)).toEqual(['qwen3-4b'])
  })

  it('hides a bundle whose archive is not on Qualcomm AI Hub’s S3 or lacks a sha256', () => {
    const parsed = parseGeniexList(
      list([
        qairt([
          variant(),
          variant({ id: 'elsewhere', bundle: { url: 'https://example.com/x.zip', size: 1, sha256: SHA } }),
          variant({ id: 'unhashed', bundle: { url: BUNDLE_URL, size: 1 } }),
        ]),
      ])
    )
    const model = parsed.models[0]
    expect(model.kind === 'qairt' && model.variants.map((v) => v.id)).toEqual(['qwen3-4b-aihub-x-elite'])
  })

  it('ignores Hugging Face rules for a platform or device it does not know, and keeps the quantizations', () => {
    const parsed = parseGeniexList(
      list([], {
        huggingface: {
          quantizations: ['Q4_0', 'Q4_K_M'],
          backends: { 'win-arm64': ['gpu', 'cpu', 'tpu'], 'linux-arm64': ['cpu'] },
        },
      })
    )
    expect(parsed.huggingface).toEqual({ quantizations: ['Q4_0', 'Q4_K_M'], backends: { 'win-arm64': ['gpu', 'cpu'] } })
  })

  it('refuses a document with a newer schema_version', () => {
    expect(() => parseGeniexList(list([], { schema_version: 2 }))).toThrow(/schema_version/)
  })
})

describe('fetchGeniexList', () => {
  it('reads conf’s main by default', async () => {
    const fetchJson = vi.fn(async () => list([gguf()]))
    const cache = memoryCache()

    const result = await fetchGeniexList({ cache, fetchJson })

    expect(fetchJson).toHaveBeenCalledWith(DEFAULT_GENIEX_MODELS_URL)
    expect(DEFAULT_GENIEX_MODELS_URL).toBe(
      'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/geniex-models.json'
    )
    expect(result.source).toBe('remote')
    expect(result.list?.models.map((m) => m.id)).toEqual(['qwen3-4b'])
    expect(cache.entry?.value).toEqual(list([gguf()]))
  })

  it('answers from a cache younger than an hour without asking the network', async () => {
    const fetchJson = vi.fn()
    const cache = memoryCache({ value: list([gguf()]), fetchedAt: Date.now() - 10 * 60_000 })

    const result = await fetchGeniexList({ cache, fetchJson })

    expect(fetchJson).not.toHaveBeenCalled()
    expect(result.source).toBe('cache')
    expect(result.list?.models).toHaveLength(1)
  })

  it('keeps the last accepted list when main carries a newer schema_version', async () => {
    const cache = memoryCache({ value: list([gguf()]), fetchedAt: Date.now() - 2 * 3_600_000 })

    const result = await fetchGeniexList({
      cache,
      fetchJson: async () => list([], { schema_version: 2 }),
    })

    expect(result.source).toBe('cache')
    expect(result.error).toMatch(/schema_version 2/)
    expect(result.list?.models.map((m) => m.id)).toEqual(['qwen3-4b'])
    expect((cache.entry?.value as { schema_version: number }).schema_version).toBe(1)
  })

  it('falls back to conf’s first release bundled here on a first launch without network', async () => {
    const result = await fetchGeniexList({
      cache: memoryCache(),
      fetchJson: async () => {
        throw new Error('offline')
      },
    })

    expect(result.source).toBe('baseline')
    expect(result.error).toBe('offline')
    // conf's first release: the Hugging Face rules alone, the curated models come after the spike.
    expect(result.list?.huggingface).toEqual({
      quantizations: ['Q4_0'],
      backends: { 'win-arm64': ['npu', 'gpu', 'cpu', 'hybrid'] },
    })
    expect(result.list?.models).toEqual([])
  })
})

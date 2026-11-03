import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_LITERT_LM_MODELS_URL,
  fetchLiteRtLmList,
  parseLiteRtLmList,
  type LiteRtLmListCache,
} from '../curated'

const SHA = 'a'.repeat(64)
const REVISION = 'b'.repeat(40)

const variant = (extra: Record<string, unknown> = {}) => ({
  id: 'gemma-4-e2b-gpu',
  backend: 'gpu',
  platforms: ['macos-arm64', 'win-x64'],
  file: { path: 'gemma-4-E2B-it.litertlm', size: 2_588_147_712, sha256: SHA },
  ...extra,
})

const model = (variants: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'gemma-4-e2b',
  name: 'Gemma 4 E2B',
  description: 'Smallest Google Gemma 4',
  task: 'chat',
  license: 'apache-2.0',
  repo: 'litert-community/gemma-4-E2B-it-litert-lm',
  revision: REVISION,
  gated: false,
  context_length: 32003,
  tools: true,
  reasoning: true,
  vision: true,
  variants,
  ...extra,
})

const list = (models: unknown[], extra: Record<string, unknown> = {}) => ({
  schema_version: 1,
  updated_at: '2026-10-22T00:00:00Z',
  huggingface: {
    orgs: ['litert-community'],
    filter: 'litert-lm',
    backends: { 'macos-arm64': ['cpu', 'gpu'], 'win-x64': ['cpu', 'npu'] },
  },
  models,
  ...extra,
})

const memoryCache = (entry: { value: unknown; fetchedAt: number } | null = null): LiteRtLmListCache & {
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

describe('parseLiteRtLmList', () => {
  it('accepts an empty model list: the Hub then shows Hugging Face models only', () => {
    const parsed = parseLiteRtLmList(list([]))
    expect(parsed.models).toEqual([])
    expect(parsed.huggingface).toEqual({
      orgs: ['litert-community'],
      backends: { 'macos-arm64': ['cpu', 'gpu'], 'win-x64': ['cpu', 'npu'] },
    })
  })

  it('reads a curated model with its variants', () => {
    const parsed = parseLiteRtLmList(
      list([
        model([
          variant({ id: 'gemma-4-e2b-cpu', backend: 'cpu' }),
          variant({ id: 'gemma-4-e2b-npu-lnl', backend: 'npu', npu: 'intel-lnl', platforms: ['win-x64'], min_runtime_version: '0.18' }),
        ]),
      ])
    )
    expect(parsed.models[0]).toMatchObject({ id: 'gemma-4-e2b', gated: false, vision: true })
    expect(parsed.models[0].variants).toEqual([
      expect.objectContaining({ id: 'gemma-4-e2b-cpu', backend: 'cpu' }),
      expect.objectContaining({ id: 'gemma-4-e2b-npu-lnl', npu: 'intel-lnl', min_runtime_version: '0.18' }),
    ])
  })

  it('hides a variant with an NPU target it does not know and keeps the model with the others', () => {
    // spec litert-lm-models "Новый целевой NPU".
    const parsed = parseLiteRtLmList(
      list([
        model([
          variant(),
          variant({ id: 'gemma-4-e2b-npu-nvl', backend: 'npu', npu: 'intel-nvl', platforms: ['win-x64'] }),
        ]),
      ])
    )
    expect(parsed.models[0].variants.map((v) => v.id)).toEqual(['gemma-4-e2b-gpu'])
  })

  it('hides a variant with a backend it does not know, an NPU variant without a target and a GPU one with a target', () => {
    const parsed = parseLiteRtLmList(
      list([
        model([
          variant(),
          variant({ id: 'tpu', backend: 'tpu' }),
          variant({ id: 'npu-untargeted', backend: 'npu', platforms: ['win-x64'] }),
          variant({ id: 'gpu-targeted', npu: 'intel-lnl' }),
        ]),
      ])
    )
    expect(parsed.models[0].variants.map((v) => v.id)).toEqual(['gemma-4-e2b-gpu'])
  })

  it('leaves out a platform it does not know, and a variant left with none', () => {
    const parsed = parseLiteRtLmList(
      list([
        model([
          variant({ platforms: ['macos-arm64', 'win-arm64'] }),
          variant({ id: 'riscv', platforms: ['linux-riscv64'] }),
        ]),
      ])
    )
    expect(parsed.models[0].variants).toEqual([
      expect.objectContaining({ id: 'gemma-4-e2b-gpu', platforms: ['macos-arm64'] }),
    ])
  })

  it('drops a model left with no variant, not the whole list', () => {
    const parsed = parseLiteRtLmList(
      list([
        model([variant({ backend: 'tpu' })], { id: 'only-tpu' }),
        model([variant()], { id: 'kept' }),
      ])
    )
    expect(parsed.models.map((m) => m.id)).toEqual(['kept'])
  })

  it('hides a variant whose file would climb out of its folder or lacks a sha256', () => {
    const parsed = parseLiteRtLmList(
      list([
        model([
          variant(),
          variant({ id: 'escape', file: { path: '../x.litertlm', size: 1, sha256: SHA } }),
          variant({ id: 'unhashed', file: { path: 'x.litertlm', size: 1 } }),
          variant({ id: 'not-litertlm', file: { path: 'x.task', size: 1, sha256: SHA } }),
        ]),
      ])
    )
    expect(parsed.models[0].variants.map((v) => v.id)).toEqual(['gemma-4-e2b-gpu'])
  })

  it('ignores Hugging Face rules for a platform or backend it does not know', () => {
    const parsed = parseLiteRtLmList(
      list([], {
        huggingface: {
          orgs: ['litert-community'],
          filter: 'litert-lm',
          backends: { 'win-x64': ['cpu', 'tpu'], 'win-arm64': ['cpu'] },
        },
      })
    )
    expect(parsed.huggingface.backends).toEqual({ 'win-x64': ['cpu'] })
  })

  it('refuses a document with a newer schema_version', () => {
    expect(() => parseLiteRtLmList(list([], { schema_version: 2 }))).toThrow(/schema_version/)
  })
})

describe('fetchLiteRtLmList', () => {
  it('reads conf’s main by default', async () => {
    const fetchJson = vi.fn(async () => list([model([variant()])]))
    const cache = memoryCache()

    const result = await fetchLiteRtLmList({ cache, fetchJson })

    expect(fetchJson).toHaveBeenCalledWith(DEFAULT_LITERT_LM_MODELS_URL)
    expect(DEFAULT_LITERT_LM_MODELS_URL).toBe(
      'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/litert-lm-models.json'
    )
    expect(result.source).toBe('remote')
    expect(result.list?.models.map((m) => m.id)).toEqual(['gemma-4-e2b'])
    expect(cache.entry?.value).toEqual(list([model([variant()])]))
  })

  it('answers from a cache younger than an hour without asking the network', async () => {
    const fetchJson = vi.fn()
    const cache = memoryCache({ value: list([model([variant()])]), fetchedAt: Date.now() - 10 * 60_000 })

    const result = await fetchLiteRtLmList({ cache, fetchJson })

    expect(fetchJson).not.toHaveBeenCalled()
    expect(result.source).toBe('cache')
    expect(result.list?.models).toHaveLength(1)
  })

  it('keeps the last accepted list when main carries a newer schema_version', async () => {
    const cache = memoryCache({ value: list([model([variant()])]), fetchedAt: Date.now() - 2 * 3_600_000 })

    const result = await fetchLiteRtLmList({
      cache,
      fetchJson: async () => list([], { schema_version: 2 }),
    })

    expect(result.source).toBe('cache')
    expect(result.error).toMatch(/schema_version 2/)
    expect(result.list?.models.map((m) => m.id)).toEqual(['gemma-4-e2b'])
    // The refused document is not cached over the accepted one.
    expect((cache.entry?.value as { schema_version: number }).schema_version).toBe(1)
  })

  it('falls back to conf’s first release bundled here on a first launch without network', async () => {
    const result = await fetchLiteRtLmList({
      cache: memoryCache(),
      fetchJson: async () => {
        throw new Error('offline')
      },
    })

    expect(result.source).toBe('baseline')
    expect(result.error).toBe('offline')
    expect(result.list?.huggingface.orgs).toEqual(['litert-community'])
    expect(result.list?.models.map((m) => m.id)).toEqual([
      'gemma-4-e2b',
      'gemma-4-e4b',
      'gemma-4-12b',
      'qwen3-4b',
    ])
  })
})

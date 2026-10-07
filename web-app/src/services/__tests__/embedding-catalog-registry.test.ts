/**
 * Tests for the remote embedding catalog loader: the remote → cache →
 * baseline chain, schema_version gating, and the strict parser that mirrors
 * the conf repo's schema and integrity check (every file path becomes a
 * download URL and a path under the model folder).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))

import {
  clearEmbeddingCatalogCache,
  embeddingDiskBytes,
  embeddingFileUrl,
  embeddingModelFile,
  embeddingProjectorFile,
  embeddingQuantLabel,
  fetchEmbeddingCatalog,
  getBaselineEmbeddingCatalog,
  getCachedEmbeddingCatalog,
  isMultimodalEmbeddingModel,
  isSafeEmbeddingFilePath,
  parseEmbeddingCatalog,
  sanitizeEmbeddingModel,
  SUPPORTED_SCHEMA_VERSION,
} from '../embedding-catalog-registry'

const REMOTE_URL = 'https://example.test/embedding.json'
const HASH = 'a'.repeat(64)
const REVISION = '0f741b5a6585bd53aeb15cd1372c56f2a0f65e12'

const file = (
  path: string,
  role: 'model' | 'mmproj' = 'model',
  bytes = 10
) => ({
  path,
  role,
  bytes,
  sha256: HASH,
})

/** A text model, as the catalog writes one. */
const model = (overrides: Record<string, unknown> = {}) => ({
  id: 'embeddinggemma-300m',
  name: 'EmbeddingGemma 300M',
  description: 'Small Google text embedding model.',
  repo: 'ggml-org/embeddinggemma-300M-GGUF',
  revision: REVISION,
  params: '308M',
  languages: 'multilingual',
  context: 2048,
  max_context: 2048,
  dims: 768,
  matryoshka_dims: [512, 256, 128],
  pooling: 'mean',
  modalities: ['text'],
  prompts: {
    query: 'task: search result | query: ',
    document: 'title: none | text: ',
  },
  license: 'gemma',
  default: true,
  min_engine: 'b11443',
  engine: 'llamacpp-upstream',
  format: 'gguf',
  icon: 'gemma-mark',
  files: [file('embeddinggemma-300M-Q8_0.gguf', 'model', 300)],
  ...overrides,
})

/** A model that reads images and audio: a projector, an image budget. */
const multimodal = (overrides: Record<string, unknown> = {}) =>
  model({
    id: 'embeddinggemma-2',
    name: 'EmbeddingGemma 2',
    context: 4096,
    max_context: 8192,
    modalities: ['text', 'image', 'audio'],
    image_max_tokens: 280,
    files: [
      file('embeddinggemma-2-Q8_0.gguf', 'model', 300),
      file('mmproj-Q8_0.gguf', 'mmproj', 500),
    ],
    ...overrides,
  })

const manifest = (
  models: unknown[] = [model()],
  overrides: Record<string, unknown> = {}
) => ({
  $schema: './schema.embedding.json',
  schema_version: SUPPORTED_SCHEMA_VERSION,
  updated_at: '2026-10-07T12:00:00Z',
  models,
  ...overrides,
})

const fetchOk = (body: unknown) => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  }))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

const fetchFails = (error: unknown) => {
  globalThis.fetch = vi.fn(async () => {
    throw error
  }) as unknown as typeof fetch
}

describe('fetchEmbeddingCatalog', () => {
  beforeEach(() => clearEmbeddingCatalogCache())
  afterEach(() => vi.restoreAllMocks())

  it('loads the remote catalog and caches it', async () => {
    fetchOk(manifest())
    const result = await fetchEmbeddingCatalog({ url: REMOTE_URL })
    expect(result.source).toBe('remote')
    expect(result.catalog.models.map((m) => m.id)).toEqual([
      'embeddinggemma-300m',
    ])
    expect(result.catalog).not.toHaveProperty('$schema')
    expect(getCachedEmbeddingCatalog()?.catalog.updated_at).toBe(
      '2026-10-07T12:00:00Z'
    )
  })

  it('serves the fresh cache without a round-trip', async () => {
    const fetchMock = fetchOk(manifest())
    await fetchEmbeddingCatalog({ url: REMOTE_URL })
    const second = await fetchEmbeddingCatalog({ url: REMOTE_URL })
    expect(second.source).toBe('cache')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses a stale cache when the network fails', async () => {
    fetchOk(manifest())
    await fetchEmbeddingCatalog({ url: REMOTE_URL })
    fetchFails(new Error('offline'))
    const result = await fetchEmbeddingCatalog({ url: REMOTE_URL, force: true })
    expect(result).toMatchObject({ source: 'cache', error: 'offline' })
  })

  it('falls back to the bundled baseline when there is no cache', async () => {
    fetchFails(new Error('offline'))
    const result = await fetchEmbeddingCatalog({ url: REMOTE_URL })
    expect(result.source).toBe('baseline')
    expect(result.fetchedAt).toBeNull()
    expect(result.catalog).toEqual(getBaselineEmbeddingCatalog())
  })

  it('rejects a manifest written for a newer client, and one with no usable model', async () => {
    fetchOk(
      manifest([model()], { schema_version: SUPPORTED_SCHEMA_VERSION + 1 })
    )
    expect((await fetchEmbeddingCatalog({ url: REMOTE_URL })).error).toMatch(
      /schema_version 2 is newer/
    )
    fetchOk(manifest([model({ id: 'Bad Id' })]))
    expect((await fetchEmbeddingCatalog({ url: REMOTE_URL })).error).toBe(
      'Embedding catalog carries no usable model'
    )
  })

  it('answers a 404 (the catalog is not published yet) from the baseline', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    })) as unknown as typeof fetch
    const result = await fetchEmbeddingCatalog({ url: REMOTE_URL })
    expect(result).toMatchObject({
      source: 'baseline',
      error: 'Embedding catalog fetch failed: 404 Not Found',
    })
  })
})

describe('strict parsing', () => {
  it('keeps a valid model, minus unknown keys', () => {
    expect(sanitizeEmbeddingModel(model({ marketing: 'new!' }))).toEqual(
      model()
    )
    expect(sanitizeEmbeddingModel(multimodal())).toEqual(multimodal())
  })

  it('drops optional fields only when absent; a false default is no default', () => {
    const { matryoshka_dims: _m, prompts: _p, default: _d, ...bare } = model()
    expect(sanitizeEmbeddingModel(bare)).toEqual(bare)
    expect(
      sanitizeEmbeddingModel(model({ default: false }))
    ).not.toHaveProperty('default')
  })

  it.each([
    ['an unsafe id', { id: '../x' }],
    ['no description', { description: '' }],
    ['a repo without an owner', { repo: 'embeddinggemma' }],
    ['a branch instead of a revision', { revision: 'main' }],
    ['no params', { params: undefined }],
    ['an unknown language form', { languages: 'english' }],
    ['a context below the floor', { context: 32, max_context: 32 }],
    ['a max_context below context', { max_context: 1024 }],
    ['no dims', { dims: 0 }],
    ['an unknown pooling', { pooling: 'max' }],
    ['no text among the modalities', { modalities: ['image'] }],
    ['a repeated modality', { modalities: ['text', 'text'] }],
    ['an unknown modality', { modalities: ['text', 'video'] }],
    ['no license', { license: '' }],
    ['a fork tag as the floor', { min_engine: 'b10269-1.7.0' }],
    ['no floor', { min_engine: undefined }],
    ['the TurboQuant engine', { engine: 'llamacpp' }],
    ['a checkpoint', { format: 'checkpoint' }],
    ['no icon', { icon: undefined }],
    ['an unsafe icon key', { icon: 'Gemma Mark' }],
    ['Matryoshka lengths that do not shrink', { matryoshka_dims: [256, 512] }],
    ['a Matryoshka length at dims', { matryoshka_dims: [768, 512] }],
    ['an empty Matryoshka list', { matryoshka_dims: [] }],
    ['an unknown prompt kind', { prompts: { passage: 'x' } }],
    ['an empty prompt', { prompts: { query: '' } }],
    ['no prompt at all', { prompts: {} }],
    ['an image budget on a text model', { image_max_tokens: 100 }],
    ['no files', { files: 'model.gguf' }],
    ['a file that is not a GGUF', { files: [file('model.safetensors')] }],
    [
      'a file without a role',
      { files: [{ ...file('a.gguf'), role: undefined }] },
    ],
    [
      'a file without a hash',
      { files: [{ path: 'a.gguf', role: 'model', bytes: 1 }] },
    ],
    ['two model files', { files: [file('a.gguf'), file('b.gguf')] }],
    ['a duplicate path', { files: [file('a.gguf'), file('a.gguf', 'mmproj')] }],
    ['a path that climbs out', { files: [file('../escape.gguf')] }],
    [
      'a projector on a text model',
      { files: [file('a.gguf'), file('p.gguf', 'mmproj')] },
    ],
  ])('drops a model with %s', (_label, overrides) => {
    expect(sanitizeEmbeddingModel(model(overrides))).toBeNull()
  })

  it.each([
    ['media without a projector', { files: [file('a.gguf')] }],
    [
      'two projectors',
      {
        files: [
          file('a.gguf'),
          file('p.gguf', 'mmproj'),
          file('q.gguf', 'mmproj'),
        ],
      },
    ],
    ['an image budget past half the context', { image_max_tokens: 2049 }],
    [
      'an image budget on a model that reads no images',
      { modalities: ['text', 'audio'] },
    ],
  ])('drops a multimodal model with %s', (_label, overrides) => {
    expect(sanitizeEmbeddingModel(multimodal(overrides))).toBeNull()
  })

  it('rejects anything that is not a manifest, keeps the first of two equal ids and one default', () => {
    expect(() => parseEmbeddingCatalog({ models: [] })).toThrow(
      /not a valid manifest/
    )
    expect(sanitizeEmbeddingModel('embeddinggemma')).toBeNull()
    const catalog = parseEmbeddingCatalog(
      manifest([model(), model({ name: 'Second' }), multimodal()])
    )
    expect(catalog.models.map((m) => [m.id, m.name, m.default])).toEqual([
      ['embeddinggemma-300m', 'EmbeddingGemma 300M', true],
      ['embeddinggemma-2', 'EmbeddingGemma 2', undefined],
    ])
  })

  it('allows folders inside the model, never a dot segment or another file type', () => {
    expect(isSafeEmbeddingFilePath('q8/model.gguf')).toBe(true)
    expect(isSafeEmbeddingFilePath('q8/./model.gguf')).toBe(false)
    expect(isSafeEmbeddingFilePath('/abs.gguf')).toBe(false)
    expect(isSafeEmbeddingFilePath('README.md')).toBe(false)
  })
})

describe('the bundled baseline', () => {
  it('offers the conf catalog with EmbeddingGemma 2 as the one default', () => {
    const { models } = getBaselineEmbeddingCatalog()
    expect(models.map((m) => m.id)).toEqual([
      'embeddinggemma-2',
      'embeddinggemma-300m',
      'qwen3-embedding-0.6b',
      'qwen3-vl-embedding-2b',
      'nomic-embed-text-v1.5',
      'bge-m3',
    ])
    expect(models.filter((m) => m.default).map((m) => m.id)).toEqual([
      'embeddinggemma-2',
    ])
    expect(models.find((m) => m.id === 'embeddinggemma-2')).toMatchObject({
      modalities: ['text', 'image', 'audio'],
      image_max_tokens: 280,
      min_engine: 'b11454',
      icon: 'gemma-mark',
    })
    for (const m of models) {
      expect(m.engine).toBe('llamacpp-upstream')
      expect(isMultimodalEmbeddingModel(m)).toBe(
        embeddingProjectorFile(m) !== undefined
      )
    }
  })
})

describe('helpers', () => {
  it('downloads from the pinned revision and counts the projector in the disk size', () => {
    const parsed = sanitizeEmbeddingModel(multimodal())!
    expect(embeddingFileUrl(parsed, parsed.files[1]!)).toBe(
      `https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/${REVISION}/mmproj-Q8_0.gguf`
    )
    expect(embeddingModelFile(parsed).path).toBe('embeddinggemma-2-Q8_0.gguf')
    expect(embeddingProjectorFile(parsed)?.path).toBe('mmproj-Q8_0.gguf')
    expect(embeddingDiskBytes(parsed)).toBe(800)
    expect(isMultimodalEmbeddingModel(parsed)).toBe(true)
  })

  it('reads the quantization off the model file', () => {
    const parsed = sanitizeEmbeddingModel(model())!
    expect(embeddingQuantLabel(parsed)).toBe('Q8_0')
    expect(embeddingProjectorFile(parsed)).toBeUndefined()
    expect(
      embeddingQuantLabel(
        sanitizeEmbeddingModel(
          model({ files: [file('Qwen3-VL-Embedding-2B.Q8_0.gguf')] })
        )!
      )
    ).toBe('Q8_0')
    expect(
      embeddingQuantLabel(
        sanitizeEmbeddingModel(model({ files: [file('weights.gguf')] }))!
      )
    ).toBe('GGUF')
  })
})

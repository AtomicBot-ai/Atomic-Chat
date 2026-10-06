/**
 * Tests for the remote decision catalog loader: the remote → cache →
 * baseline chain, schema_version gating, and the strict parser (every file
 * path becomes a download URL and a path under the model folder).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))

import {
  clearDecisionCatalogCache,
  decisionCheckpointBytes,
  decisionDiskBytes,
  decisionFileUrl,
  decisionModelFile,
  decisionProjectorFile,
  decisionQuantLabel,
  fetchDecisionCatalog,
  getBaselineDecisionCatalog,
  getCachedDecisionCatalog,
  isNonCommercialLicense,
  isSafeDecisionFilePath,
  parseDecisionCatalog,
  REQUIRED_DECISION_FILES,
  sanitizeDecisionModel,
  SUPPORTED_SCHEMA_VERSION,
} from '../decision-catalog-registry'

const REMOTE_URL = 'https://example.test/decision.json'
const HASH = 'a'.repeat(64)
const REVISION = 'e4e9ddf21a7b1903b7acffd8814ad4307bf63a67'

const file = (path: string, bytes = 10) => ({ path, bytes, sha256: HASH })

const model = (overrides: Record<string, unknown> = {}) => ({
  id: 'laya-multilingual',
  name: 'Laya Multilingual',
  description: 'Decision model for 100+ languages.',
  repo: 'convaiinnovations/laya-multilingual',
  revision: REVISION,
  backbone: 'mmBERT-base',
  params: '322M',
  languages: 'multilingual',
  context: 1024,
  calibrated: false,
  license: 'apache-2.0',
  default: true,
  min_engine: 'b10269-1.7.0',
  gguf_cache_bytes: 1000,
  files: [
    file('model.safetensors', 600),
    file('rl_agent_config.json'),
    file('encoder/config.json'),
    file('tokenizer/tokenizer.json', 300),
    file('tokenizer/tokenizer_config.json'),
  ],
  ...overrides,
})

const manifest = (
  models: unknown[] = [model()],
  overrides: Record<string, unknown> = {}
) => ({
  $schema: './schema.decision.json',
  schema_version: SUPPORTED_SCHEMA_VERSION,
  updated_at: '2026-10-01T12:00:00Z',
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

describe('fetchDecisionCatalog', () => {
  beforeEach(() => clearDecisionCatalogCache())
  afterEach(() => vi.restoreAllMocks())

  it('loads the remote catalog and caches it', async () => {
    fetchOk(manifest())
    const result = await fetchDecisionCatalog({ url: REMOTE_URL })
    expect(result.source).toBe('remote')
    expect(result.catalog.models.map((m) => m.id)).toEqual([
      'laya-multilingual',
    ])
    expect(result.catalog).not.toHaveProperty('$schema')
    expect(getCachedDecisionCatalog()?.catalog.updated_at).toBe(
      '2026-10-01T12:00:00Z'
    )
  })

  it('serves the fresh cache without a round-trip', async () => {
    const fetchMock = fetchOk(manifest())
    await fetchDecisionCatalog({ url: REMOTE_URL })
    const second = await fetchDecisionCatalog({ url: REMOTE_URL })
    expect(second.source).toBe('cache')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses a stale cache when the network fails', async () => {
    fetchOk(manifest())
    await fetchDecisionCatalog({ url: REMOTE_URL })
    fetchFails(new Error('offline'))
    const result = await fetchDecisionCatalog({ url: REMOTE_URL, force: true })
    expect(result).toMatchObject({ source: 'cache', error: 'offline' })
  })

  it('falls back to the bundled baseline when there is no cache', async () => {
    fetchFails(new Error('offline'))
    const result = await fetchDecisionCatalog({ url: REMOTE_URL })
    expect(result.source).toBe('baseline')
    expect(result.fetchedAt).toBeNull()
    expect(result.catalog).toEqual(getBaselineDecisionCatalog())
  })

  it('rejects a manifest written for a newer client, and one with no usable model', async () => {
    fetchOk(
      manifest([model()], { schema_version: SUPPORTED_SCHEMA_VERSION + 1 })
    )
    expect((await fetchDecisionCatalog({ url: REMOTE_URL })).error).toMatch(
      /schema_version 2 is newer/
    )
    fetchOk(manifest([model({ id: 'Bad Id' })]))
    expect((await fetchDecisionCatalog({ url: REMOTE_URL })).error).toBe(
      'Decision catalog carries no usable model'
    )
  })

  it('answers a non-200 from the baseline', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    })) as unknown as typeof fetch
    const result = await fetchDecisionCatalog({ url: REMOTE_URL })
    expect(result).toMatchObject({
      source: 'baseline',
      error: 'Decision catalog fetch failed: 404 Not Found',
    })
  })
})

describe('strict parsing', () => {
  it('keeps a valid model, minus unknown keys, as a TurboQuant checkpoint by default', () => {
    expect(sanitizeDecisionModel(model({ marketing: 'new!' }))).toEqual({
      ...model(),
      engine: 'llamacpp',
      format: 'checkpoint',
    })
  })

  it('drops optional fields that do not parse', () => {
    const parsed = sanitizeDecisionModel(
      model({
        min_engine: '1.7.0',
        gguf_cache_bytes: -1,
        default: 'yes',
        license: '',
      })
    )
    expect(parsed).not.toHaveProperty('min_engine')
    expect(parsed).not.toHaveProperty('gguf_cache_bytes')
    expect(parsed).not.toHaveProperty('default')
    expect(parsed).not.toHaveProperty('license')
  })

  it.each([
    ['an unsafe id', { id: '../x' }],
    ['a repo without an owner', { repo: 'laya' }],
    ['a branch instead of a revision', { revision: 'main' }],
    ['an unknown language form', { languages: 'english' }],
    ['no context', { context: 0 }],
    ['calibration as a string', { calibrated: 'no' }],
    ['no files', { files: 'model.safetensors' }],
    ['a missing required file', { files: [file('model.safetensors')] }],
    [
      'a file without a hash',
      { files: [...model().files, { path: 'README.md', bytes: 1 }] },
    ],
    [
      'a duplicate path',
      { files: [...model().files, file('model.safetensors')] },
    ],
    ['a root config.json', { files: [...model().files, file('config.json')] }],
    [
      'a path that climbs out',
      { files: [...model().files, file('../escape.json')] },
    ],
  ])('drops a model with %s', (_label, overrides) => {
    expect(sanitizeDecisionModel(model(overrides))).toBeNull()
  })

  it('rejects anything that is not a manifest, and keeps the first of two equal ids', () => {
    expect(() => parseDecisionCatalog({ models: [] })).toThrow(
      /not a valid manifest/
    )
    expect(sanitizeDecisionModel('laya')).toBeNull()
    const catalog = parseDecisionCatalog(
      manifest([
        model(),
        model({ name: 'Second' }),
        model({ id: 'laya', default: false }),
      ])
    )
    expect(catalog.models.map((m) => [m.id, m.name])).toEqual([
      ['laya-multilingual', 'Laya Multilingual'],
      ['laya', 'Laya Multilingual'],
    ])
  })

  it('allows folders inside the model, never a root config.json or a dot segment', () => {
    expect(isSafeDecisionFilePath('encoder/config.json')).toBe(true)
    expect(isSafeDecisionFilePath('config.json')).toBe(false)
    expect(isSafeDecisionFilePath('tokenizer/./x.json')).toBe(false)
    expect(isSafeDecisionFilePath('/abs.json')).toBe(false)
  })
})

describe('the bundled baseline', () => {
  it('offers the verified checkpoints, then the stock llama.cpp GGUFs, one default per engine', () => {
    const { models } = getBaselineDecisionCatalog()
    expect(
      models.filter((m) => m.engine === 'llamacpp').map((m) => m.id)
    ).toEqual(['laya-multilingual', 'laya', 'laya-typed-decisions'])
    expect(
      models.filter((m) => m.engine === 'llamacpp-upstream').map((m) => m.id)
    ).toEqual([
      'julia-1',
      'laya-gguf',
      'lev',
      'kev-4b',
      'bespoke-nimble-9b',
      'clef-flash',
      'clef',
      'openjev',
    ])
    expect(models.filter((m) => m.default).map((m) => m.id)).toEqual([
      'laya-multilingual',
      'julia-1',
    ])
    expect(models.find((m) => m.id === 'clef')).toMatchObject({
      format: 'gguf',
      decision_type: 'clef',
      vision: true,
      min_engine: 'b11418',
      icon: 'cloudflare',
    })
  })
})

describe('helpers', () => {
  it('downloads from the pinned revision and counts the cache in the disk size', () => {
    const parsed = sanitizeDecisionModel(model())!
    expect(decisionFileUrl(parsed, parsed.files[2]!)).toBe(
      `https://huggingface.co/convaiinnovations/laya-multilingual/resolve/${REVISION}/encoder/config.json`
    )
    expect(decisionCheckpointBytes(parsed)).toBe(930)
    expect(decisionDiskBytes(parsed)).toBe(1930)
    const { gguf_cache_bytes: _gguf, ...withoutCache } = parsed
    expect(decisionDiskBytes(withoutCache)).toBe(930)
  })
})

describe('stock llama.cpp GGUF models', () => {
  const HASH = 'c'.repeat(64)
  const gguf = (overrides: Record<string, unknown> = {}) => ({
    id: 'clef-flash',
    name: 'Clef Flash',
    repo: 'ggml-org/Clef-Flash-GGUF',
    revision: 'd'.repeat(40),
    languages: 'en',
    context: 8192,
    calibrated: false,
    license: 'apache-2.0',
    min_engine: 'b11418',
    engine: 'llamacpp-upstream',
    format: 'gguf',
    decision_type: 'clef',
    icon: 'cloudflare',
    vision: true,
    files: [
      {
        path: 'Clef-Flash-Q4_K_M.gguf',
        role: 'model',
        bytes: 6486448288,
        sha256: HASH,
      },
      {
        path: 'mmproj-Clef-Flash-Q8_0.gguf',
        role: 'mmproj',
        bytes: 624229728,
        sha256: HASH,
      },
    ],
    ...overrides,
  })

  it('keeps the engine, the type, the logo, the projector and the upstream tag', () => {
    const parsed = sanitizeDecisionModel(gguf())!
    expect(parsed).toMatchObject({
      engine: 'llamacpp-upstream',
      format: 'gguf',
      decision_type: 'clef',
      icon: 'cloudflare',
      vision: true,
      min_engine: 'b11418',
    })
    expect(decisionModelFile(parsed)?.path).toBe('Clef-Flash-Q4_K_M.gguf')
    expect(decisionProjectorFile(parsed)?.path).toBe(
      'mmproj-Clef-Flash-Q8_0.gguf'
    )
    expect(decisionQuantLabel(parsed)).toBe('Q4_K_M')
  })

  it.each([
    ['a checkpoint on the upstream engine', { format: 'checkpoint' }],
    ['an unknown engine', { engine: 'vllm' }],
    [
      'two model files',
      {
        files: [
          ...gguf().files.slice(0, 1),
          { path: 'b.gguf', role: 'model', bytes: 1, sha256: HASH },
        ],
      },
    ],
    [
      'a file without a role',
      { files: [{ path: 'a.gguf', bytes: 1, sha256: HASH }] },
    ],
    [
      'a file that is not a GGUF',
      {
        files: [
          { path: 'a.safetensors', role: 'model', bytes: 1, sha256: HASH },
        ],
      },
    ],
  ])('drops %s', (_label, overrides) => {
    expect(sanitizeDecisionModel(gguf(overrides))).toBeNull()
  })

  it('reads a TurboQuant tag as no floor for upstream, and drops vision without a projector', () => {
    const parsed = sanitizeDecisionModel(
      gguf({ min_engine: 'b10269-1.7.0', files: gguf().files.slice(0, 1) })
    )!
    expect(parsed).not.toHaveProperty('min_engine')
    expect(parsed).not.toHaveProperty('vision')
    expect(decisionProjectorFile(parsed)).toBeUndefined()
  })

  it('is dropped whole by a client that predates it, which keeps only checkpoints', () => {
    // The 1.x parser required the four checkpoint files on every model.
    expect(
      gguf().files.every((f) =>
        REQUIRED_DECISION_FILES.every((r) => r !== f.path)
      )
    ).toBe(true)
  })

  it('tells a non-commercial license apart', () => {
    expect(isNonCommercialLicense('cc-by-nc-4.0')).toBe(true)
    expect(isNonCommercialLicense('cc-by-nc-sa-4.0')).toBe(true)
    expect(isNonCommercialLicense('apache-2.0')).toBe(false)
    expect(isNonCommercialLicense(undefined)).toBe(false)
  })
})

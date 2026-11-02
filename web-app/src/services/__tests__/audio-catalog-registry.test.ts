/**
 * Tests for the audio catalog loader: the unified catalog's `audio`
 * collection, the remote → cache → baseline chain of a named file,
 * schema_version gating, and the strict parser that mirrors the conf
 * repo's schema (every path becomes a download URL and a file under the audio
 * models folder).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))

const unified = vi.hoisted(() => ({ collection: vi.fn() }))
vi.mock('../unified-model-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../unified-model-catalog')>()),
  unifiedModelCollection: unified.collection,
}))

import {
  CACHE_TTL_MS,
  SUPPORTED_SCHEMA_VERSION,
  audioModelsOf,
  clearAudioCatalogCache,
  fetchAudioCatalog,
  getBaselineAudioCatalog,
  getCachedAudioCatalog,
  isSafeAudioFilePath,
  parseAudioCatalog,
  recommendedAudioQuant,
  sanitizeAudioModel,
} from '../audio-catalog-registry'

const REMOTE_URL = 'https://example.test/audio.json'
const REVISION = '874fcb41ececda20bcbc0782d6b4ea7f7d069ea8'
const HASH = 'a'.repeat(64)

const quant = (overrides: Record<string, unknown> = {}) => ({
  id: 'q8_0',
  label: 'Q8',
  path: 'Stable-Audio-GGUF/stable-audio-q8_0.gguf',
  filename: 'stable-audio-q8_0.gguf',
  bytes: 1683576512,
  sha256: HASH,
  recommended: true,
  ...overrides,
})

const model = (overrides: Record<string, unknown> = {}) => ({
  id: 'stable-audio-3-small-sfx',
  name: 'Stable Audio 3 Small SFX',
  developer: 'Stability AI',
  description: 'Short sound effects from a description.',
  license: 'Stability AI Community License',
  attribution: 'Powered by Stability AI',
  mode: 'effects',
  engines: ['audio-cpp'],
  family: 'stable_audio',
  task: 'gen',
  repo: 'audio-cpp/audio.cpp-gguf',
  revision: REVISION,
  quants: [quant()],
  default_voice: null,
  controls: ['durationSec', 'seed'],
  defaults: { durationSec: 5, seed: 42 },
  ranges: { durationSec: [1, 30] },
  ...overrides,
})

const manifest = (
  models: unknown[] = [model()],
  overrides: Record<string, unknown> = {}
) => ({
  $schema: './schema.audio.json',
  schema_version: SUPPORTED_SCHEMA_VERSION,
  updated_at: '2026-11-01T20:00:00Z',
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

const fetchFails = (status = 404) => {
  const fetchMock = vi.fn(async () => ({
    ok: false,
    status,
    statusText: 'Not Found',
    json: async () => ({}),
  }))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('sanitizeAudioModel', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}))
  afterEach(() => vi.restoreAllMocks())

  it('keeps a model as the catalog writes it', () => {
    expect(sanitizeAudioModel(model())).toEqual(model())
  })

  it('strips what the schema does not know', () => {
    const sanitized = sanitizeAudioModel(
      model({ extra: true, defaults: { seed: 1, unknown: 3 } })
    )

    expect(sanitized).not.toHaveProperty('extra')
    expect(sanitized?.defaults).toEqual({ seed: 1 })
  })

  it('reads a null attribution and an absent voice as none', () => {
    const sanitized = sanitizeAudioModel(
      model({ attribution: null, default_voice: undefined })
    )

    expect(sanitized).toMatchObject({ attribution: null, default_voice: null })
  })

  it('keeps a logo key, and drops a malformed one rather than the model', () => {
    expect(sanitizeAudioModel(model({ icon: 'stability' }))?.icon).toBe(
      'stability'
    )
    const odd = sanitizeAudioModel(model({ icon: '../logo.svg' }))
    expect(odd).not.toBeNull()
    expect(odd).not.toHaveProperty('icon')
  })

  it('drops a control this build does not know, not the model', () => {
    expect(
      sanitizeAudioModel(model({ controls: ['seed', 'warp_factor'] }))?.controls
    ).toEqual(['seed'])
  })

  it('carries the three option maps through', () => {
    expect(
      sanitizeAudioModel(
        model({
          load_options: { a: 1 },
          session_options: { b: true },
          default_request_options: { c: 'd' },
        })
      )
    ).toMatchObject({
      load_options: { a: 1 },
      session_options: { b: true },
      default_request_options: { c: 'd' },
    })
  })

  it.each([
    ['a missing name', { name: '' }],
    ['a missing developer', { developer: undefined }],
    ['an unknown mode', { mode: 'podcast' }],
    ['speech on the gen task', { mode: 'speech', task: 'gen' }],
    ['music on the tts task', { mode: 'music', task: 'tts' }],
    ['another engine', { engines: ['sd-cpp'] }],
    ['a moving revision', { revision: 'main' }],
    ['a malformed repo', { repo: '../evil' }],
    ['no quant', { quants: [] }],
    ['an option that is not a value', { load_options: { a: {} } }],
    ['a negative duration', { defaults: { durationSec: -1 } }],
    ['a range upside down', { ranges: { durationSec: [30, 1] } }],
    ['controls that are not a list', { controls: 'seed' }],
  ])('rejects %s', (_label, overrides) => {
    expect(sanitizeAudioModel(model(overrides))).toBeNull()
  })

  it.each([
    ['a path climbing out', { path: '../secrets.gguf' }],
    ['a path with an empty segment', { path: 'a//b.gguf' }],
    ['a file that is not a GGUF', { path: 'a/b.exe', filename: 'b.exe' }],
    ['a filename with a folder', { filename: 'a/b.gguf' }],
    ['a filename climbing out', { filename: '..\\b.gguf' }],
    ['no size', { bytes: 0 }],
    ['no hash', { sha256: undefined }],
    ['a short hash', { sha256: 'abc' }],
  ])('rejects a quant with %s', (_label, overrides) => {
    expect(sanitizeAudioModel(model({ quants: [quant(overrides)] }))).toBeNull()
  })

  it('rejects two quants saved to one file', () => {
    expect(
      sanitizeAudioModel(
        model({ quants: [quant(), quant({ id: 'q4_0', path: 'b/c.gguf' })] })
      )
    ).toBeNull()
  })
})

describe('isSafeAudioFilePath', () => {
  it('takes folders inside the repo and nothing that climbs out', () => {
    expect(isSafeAudioFilePath('ACE-Step1.5-GGUF/turbo/ace.gguf')).toBe(true)
    expect(isSafeAudioFilePath('a/../b.gguf')).toBe(false)
    expect(isSafeAudioFilePath('/b.gguf')).toBe(false)
    expect(isSafeAudioFilePath('./b.gguf')).toBe(false)
  })
})

describe('parseAudioCatalog', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}))
  afterEach(() => vi.restoreAllMocks())

  it('drops an invalid model and a repeated id, keeping the rest in order', () => {
    const catalog = parseAudioCatalog(
      manifest([
        model(),
        model({ name: '', id: 'broken' }),
        model({ name: 'Again' }),
        model({ id: 'second' }),
      ])
    )

    expect(catalog.models.map((entry) => entry.id)).toEqual([
      'stable-audio-3-small-sfx',
      'second',
    ])
    expect(catalog.models[0].name).toBe('Stable Audio 3 Small SFX')
  })

  it('rejects a payload with nothing usable, so the caller falls back', () => {
    expect(() => parseAudioCatalog(manifest([{}]))).toThrow('no usable model')
    expect(() => parseAudioCatalog('nope')).toThrow('not a valid manifest')
  })

  it('refuses a schema newer than this build reads', () => {
    expect(() =>
      parseAudioCatalog(manifest(undefined, { schema_version: 2 }))
    ).toThrow('Update the application')
  })
})

describe('the bundled baseline', () => {
  it('lists the four models the app ships, speech default first', () => {
    const catalog = getBaselineAudioCatalog()

    expect(catalog.models.map((entry) => entry.id)).toEqual([
      'qwen3-tts-1.7b-customvoice',
      'moss-tts-nano-100m',
      'ace-step-1.5-turbo',
      'stable-audio-3-small-sfx',
    ])
    expect(audioModelsOf(catalog, 'speech')[0].default_voice).toBe('vivian')
    expect(catalog.models.map((entry) => entry.icon)).toEqual([
      'qwen',
      'openmoss',
      'acestep',
      'stability',
    ])
  })

  it('carries the notice Stable Audio’s license asks for', () => {
    const [effects] = audioModelsOf(getBaselineAudioCatalog(), 'effects')

    expect(effects.attribution).toBe('Powered by Stability AI')
  })

  it('offers no model that needs eSpeak-ng', () => {
    const names = getBaselineAudioCatalog()
      .models.map((entry) => entry.family)
      .join(' ')

    expect(names).not.toMatch(/kokoro|piper|sano|inflect/i)
  })
})

describe('recommendedAudioQuant', () => {
  it('takes the recommended quant, else the first', () => {
    const first = quant({ recommended: undefined })
    const second = quant({ id: 'q4_0', path: 'x/y.gguf', filename: 'y.gguf' })
    const parsed = sanitizeAudioModel(model({ quants: [first, second] }))
    const plain = sanitizeAudioModel(
      model({
        quants: [first, { ...second, recommended: undefined }],
      })
    )

    expect(parsed && recommendedAudioQuant(parsed).id).toBe('q4_0')
    expect(plain && recommendedAudioQuant(plain).id).toBe('q8_0')
  })
})

describe('fetchAudioCatalog', () => {
  const realFetch = globalThis.fetch

  beforeEach(() => {
    clearAudioCatalogCache()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('reads the unified catalog’s audio collection unless a file is named', async () => {
    const fetchMock = fetchOk(manifest())
    unified.collection.mockResolvedValue({
      data: manifest(),
      source: 'cache',
      fetchedAt: 42,
    })

    const result = await fetchAudioCatalog({ force: true })

    expect(unified.collection).toHaveBeenCalledWith('audio', true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ source: 'cache', fetchedAt: 42 })
    expect(result.catalog.models).toHaveLength(1)
  })

  it('takes the network, caches it, and serves the cache within the TTL', async () => {
    const fetchMock = fetchOk(manifest())

    const first = await fetchAudioCatalog({ url: REMOTE_URL })
    const second = await fetchAudioCatalog({ url: REMOTE_URL })

    expect(first.source).toBe('remote')
    expect(second.source).toBe('cache')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('asks again once the cache is past its TTL', async () => {
    fetchOk(manifest())
    await fetchAudioCatalog({ url: REMOTE_URL })
    vi.spyOn(Date, 'now').mockReturnValue(
      (getCachedAudioCatalog()?.fetchedAt ?? 0) + CACHE_TTL_MS + 1
    )
    const fetchMock = fetchOk(manifest())

    await expect(fetchAudioCatalog({ url: REMOTE_URL })).resolves.toMatchObject(
      { source: 'remote' }
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to the baseline while conf does not publish the file', async () => {
    fetchFails(404)

    const result = await fetchAudioCatalog({ url: REMOTE_URL })

    expect(result.source).toBe('baseline')
    expect(result.catalog.models).toHaveLength(4)
    expect(result.error).toContain('404')
  })

  it('prefers a stale cache to the baseline', async () => {
    fetchOk(manifest())
    await fetchAudioCatalog({ url: REMOTE_URL })
    fetchFails(500)

    const result = await fetchAudioCatalog({ url: REMOTE_URL, force: true })

    expect(result.source).toBe('cache')
    expect(result.catalog.models).toHaveLength(1)
  })

  it('falls back on a payload it cannot read', async () => {
    fetchOk({ nope: true })

    await expect(fetchAudioCatalog({ url: REMOTE_URL })).resolves.toMatchObject(
      {
        source: 'baseline',
      }
    )
  })
})

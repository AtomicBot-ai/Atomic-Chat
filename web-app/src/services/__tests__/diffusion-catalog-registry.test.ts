/**
 * Tests for the remote diffusion catalog loader.
 *
 * Covers the public surface in `services/diffusion-catalog-registry.ts`:
 *   - remote → cache → baseline priority chain,
 *   - schema_version gating,
 *   - the strict parser: file names become download URLs and disk paths, so
 *     anything that could escape the models root or change extension is
 *     dropped before it is ever fetched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))

import {
  clearDiffusionCatalogCache,
  fetchDiffusionCatalog,
  findFamily,
  findQuant,
  getBaselineDiffusionCatalog,
  getCachedDiffusionCatalog,
  isSafeSideFilename,
  parseDiffusionCatalog,
  sanitizeDiffusionFamily,
  SUPPORTED_SCHEMA_VERSION,
} from '../diffusion-catalog-registry'

const REMOTE_URL = 'https://example.test/diffusion.json'
const HASH = 'e'.repeat(64)

const family = (overrides: Record<string, unknown> = {}) => ({
  id: 'z-image',
  name: 'Z-Image Turbo',
  developer: 'Tongyi-MAI',
  modality: 'image',
  engines: ['sdcpp', 'diffusers'],
  transformer: {
    repo: 'unsloth/Z-Image-Turbo-GGUF',
    quants: [
      { id: 'q4_k_m', label: 'Q4_K_M', filename: 'z-image-turbo-Q4_K_M.gguf', bytes: 5017613376, sha256: HASH, recommended: true },
    ],
  },
  vae: { repo: 'unsloth/Z-Image-Turbo-ComfyUI', filename: 'split_files/vae/ae.safetensors', bytes: 335304388 },
  text_encoders: [
    { repo: 'unsloth/Z-Image-Turbo-ComfyUI', filename: 'split_files/text_encoders/qwen_3_4b.safetensors', bytes: 8044982048, field: 'llm' },
  ],
  defaults: { steps: 8, cfg_scale: 1.0, width: 1024, height: 1024 },
  ranges: { steps: [1, 50], dims: [256, 2048], dim_multiple: 16 },
  capabilities: { negative_prompt: false, guidance: false, workflows: ['create'] },
  ...overrides,
})

const manifest = (families: unknown[] = [family()], overrides: Record<string, unknown> = {}) => ({
  $schema: './schema.diffusion.json',
  schema_version: SUPPORTED_SCHEMA_VERSION,
  updated_at: '2026-09-10T18:00:00Z',
  families,
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

describe('fetchDiffusionCatalog', () => {
  beforeEach(() => clearDiffusionCatalogCache())
  afterEach(() => vi.restoreAllMocks())

  it('loads the remote catalog and caches it', async () => {
    fetchOk(manifest())
    const result = await fetchDiffusionCatalog({ url: REMOTE_URL })
    expect(result.source).toBe('remote')
    expect(result.catalog.families.map((f) => f.id)).toEqual(['z-image'])
    expect(result.catalog).not.toHaveProperty('$schema')
    expect(getCachedDiffusionCatalog()?.catalog.updated_at).toBe('2026-09-10T18:00:00Z')
  })

  it('serves the fresh cache without a round-trip', async () => {
    const fetchMock = fetchOk(manifest())
    await fetchDiffusionCatalog({ url: REMOTE_URL })
    const second = await fetchDiffusionCatalog({ url: REMOTE_URL })
    expect(second.source).toBe('cache')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses a stale cache when the network fails', async () => {
    fetchOk(manifest())
    await fetchDiffusionCatalog({ url: REMOTE_URL })
    fetchFails(new Error('offline'))
    const result = await fetchDiffusionCatalog({ url: REMOTE_URL, force: true })
    expect(result.source).toBe('cache')
    expect(result.error).toBe('offline')
    expect(result.catalog.families).toHaveLength(1)
  })

  it('falls back to the bundled baseline when there is no cache', async () => {
    fetchFails(new Error('offline'))
    const result = await fetchDiffusionCatalog({ url: REMOTE_URL })
    expect(result.source).toBe('baseline')
    expect(result.fetchedAt).toBeNull()
    expect(result.catalog).toEqual(getBaselineDiffusionCatalog())
  })

  it('rejects a manifest written for a newer client', async () => {
    fetchOk(manifest([family()], { schema_version: SUPPORTED_SCHEMA_VERSION + 1 }))
    const result = await fetchDiffusionCatalog({ url: REMOTE_URL })
    expect(result.source).toBe('baseline')
    expect(result.error).toMatch(/schema_version 2 is newer/)
  })

  it('rejects a payload with no usable family', async () => {
    fetchOk(manifest([family({ id: 'sdxl' })]))
    const result = await fetchDiffusionCatalog({ url: REMOTE_URL })
    expect(result.source).toBe('baseline')
    expect(result.error).toBe('Diffusion catalog carries no usable family')
  })
})

describe('strict parsing', () => {
  it('keeps a valid family verbatim, minus unknown keys', () => {
    const parsed = sanitizeDiffusionFamily(family({ marketing_blurb: 'new!' }))
    expect(parsed).toEqual({
      id: 'z-image',
      name: 'Z-Image Turbo',
      developer: 'Tongyi-MAI',
      modality: 'image',
      engines: ['sdcpp', 'diffusers'],
      transformer: {
        repo: 'unsloth/Z-Image-Turbo-GGUF',
        quants: [
          { id: 'q4_k_m', label: 'Q4_K_M', filename: 'z-image-turbo-Q4_K_M.gguf', bytes: 5017613376, sha256: HASH, recommended: true },
        ],
      },
      vae: { repo: 'unsloth/Z-Image-Turbo-ComfyUI', filename: 'split_files/vae/ae.safetensors', bytes: 335304388 },
      text_encoders: [
        { repo: 'unsloth/Z-Image-Turbo-ComfyUI', filename: 'split_files/text_encoders/qwen_3_4b.safetensors', bytes: 8044982048, field: 'llm' },
      ],
      defaults: { steps: 8, cfg_scale: 1, width: 1024, height: 1024 },
      ranges: { steps: [1, 50], dims: [256, 2048], dim_multiple: 16 },
      capabilities: { negative_prompt: false, guidance: false, workflows: ['create'] },
    })
  })

  it('drops a quant whose file name is not a flat .gguf', () => {
    const parsed = sanitizeDiffusionFamily(
      family({
        transformer: {
          repo: 'unsloth/Z-Image-Turbo-GGUF',
          quants: [
            { id: 'q4_k_m', label: 'Q4_K_M', filename: 'ok-Q4_K_M.gguf', bytes: 1 },
            { id: 'q5_k_m', label: 'Q5_K_M', filename: '../escape.gguf', bytes: 1 },
            { id: 'q6_k', label: 'Q6_K', filename: 'sub/dir.gguf', bytes: 1 },
            { id: 'q8_0', label: 'Q8_0', filename: 'weights.safetensors', bytes: 1 },
            { id: 'f16', label: 'F16', filename: 'weights.gguf', bytes: 0 },
          ],
        },
      })
    )
    expect(parsed?.transformer.quants.map((q) => q.id)).toEqual(['q4_k_m'])
  })

  it('rejects the whole family when a side file could escape the models root', () => {
    expect(
      sanitizeDiffusionFamily(
        family({ vae: { repo: 'unsloth/x', filename: 'split_files/../../ae.safetensors', bytes: 1 } })
      )
    ).toBeNull()
    expect(
      sanitizeDiffusionFamily(
        family({ text_encoders: [{ repo: 'unsloth/x', filename: 'enc.bin', bytes: 1, field: 'llm' }] })
      )
    ).toBeNull()
    expect(
      sanitizeDiffusionFamily(
        family({ text_encoders: [{ repo: 'unsloth/x', filename: 'enc.safetensors', bytes: 1 }] })
      )
    ).toBeNull()
  })

  it('rejects unknown ids, bad bytes and malformed ranges', () => {
    expect(sanitizeDiffusionFamily(family({ id: 'sdxl' }))).toBeNull()
    expect(
      sanitizeDiffusionFamily(family({ vae: { repo: 'unsloth/x', filename: 'ae.safetensors', bytes: '335304388' } }))
    ).toBeNull()
    expect(sanitizeDiffusionFamily(family({ ranges: { steps: [50, 1], dims: [256, 2048], dim_multiple: 16 } }))).toBeNull()
    expect(sanitizeDiffusionFamily(family({ engines: ['comfy'] }))).toBeNull()
    expect(sanitizeDiffusionFamily(family({ vae_format: 'sdxl' }))).toBeNull()
  })

  it('drops an invalid family but keeps the rest of the catalog', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parsed = parseDiffusionCatalog(
      manifest([family({ id: 'nope' }), family(), family({ id: 'flux.1' })])
    )
    expect(parsed.families.map((f) => f.id)).toEqual(['z-image', 'flux.1'])
    expect(warn).toHaveBeenCalledWith(
      '[diffusion-catalog-registry] Dropping invalid family nope'
    )
    warn.mockRestore()
  })

  it('knows a safe side-file path when it sees one', () => {
    expect(isSafeSideFilename('split_files/vae/ae.safetensors')).toBe(true)
    expect(isSafeSideFilename('Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf')).toBe(true)
    expect(isSafeSideFilename('/etc/passwd.gguf')).toBe(false)
    expect(isSafeSideFilename('a/../b.gguf')).toBe(false)
    expect(isSafeSideFilename('a//b.gguf')).toBe(false)
    expect(isSafeSideFilename('a b.gguf')).toBe(false)
  })
})

describe('baseline and lookups', () => {
  it('bundles a catalog that passes its own validation', () => {
    const baseline = getBaselineDiffusionCatalog()
    expect(baseline.schema_version).toBe(SUPPORTED_SCHEMA_VERSION)
    expect(baseline.families.map((f) => f.id)).toEqual([
      'z-image',
      'flux.2-klein',
      'flux.1',
      'qwen-image',
    ])
  })

  it('finds families and quants by id', () => {
    const baseline = getBaselineDiffusionCatalog()
    const klein = findFamily(baseline, 'flux.2-klein')
    expect(klein?.vae_format).toBe('flux2')
    expect(findQuant(klein!, 'q4_k_m')?.recommended).toBe(true)
    expect(findQuant(klein!, 'q2_k')).toBeUndefined()
    expect(findFamily(baseline, 'sdxl')).toBeUndefined()
  })
})

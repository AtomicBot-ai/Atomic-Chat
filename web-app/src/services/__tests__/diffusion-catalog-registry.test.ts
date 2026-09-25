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

import { LTX_2, WAN_22 } from '@/lib/diffusion/__tests__/video-fixtures'
import {
  clearDiffusionCatalogCache,
  fetchDiffusionCatalog,
  findFamily,
  findQuant,
  getBaselineDiffusionCatalog,
  getCachedDiffusionCatalog,
  isSafeQuantFilename,
  isSafeSideFilename,
  mergeBundledDiffusionFamilies,
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
      {
        id: 'q4_k_m',
        label: 'Q4_K_M',
        filename: 'z-image-turbo-Q4_K_M.gguf',
        bytes: 5017613376,
        sha256: HASH,
        recommended: true,
      },
    ],
  },
  vae: {
    repo: 'unsloth/Z-Image-Turbo-ComfyUI',
    filename: 'split_files/vae/ae.safetensors',
    bytes: 335304388,
  },
  text_encoders: [
    {
      repo: 'unsloth/Z-Image-Turbo-ComfyUI',
      filename: 'split_files/text_encoders/qwen_3_4b.safetensors',
      bytes: 8044982048,
      field: 'llm',
    },
  ],
  defaults: { steps: 8, cfg_scale: 1.0, width: 1024, height: 1024 },
  ranges: { steps: [1, 50], dims: [256, 2048], dim_multiple: 16 },
  capabilities: {
    negative_prompt: false,
    guidance: false,
    workflows: ['create'],
  },
  ...overrides,
})

const manifest = (
  families: unknown[] = [family()],
  overrides: Record<string, unknown> = {}
) => ({
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
    expect(getCachedDiffusionCatalog()?.catalog.updated_at).toBe(
      '2026-09-10T18:00:00Z'
    )
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
    fetchOk(
      manifest([family()], { schema_version: SUPPORTED_SCHEMA_VERSION + 1 })
    )
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
          {
            id: 'q4_k_m',
            label: 'Q4_K_M',
            filename: 'z-image-turbo-Q4_K_M.gguf',
            bytes: 5017613376,
            sha256: HASH,
            recommended: true,
          },
        ],
      },
      vae: {
        repo: 'unsloth/Z-Image-Turbo-ComfyUI',
        filename: 'split_files/vae/ae.safetensors',
        bytes: 335304388,
      },
      text_encoders: [
        {
          repo: 'unsloth/Z-Image-Turbo-ComfyUI',
          filename: 'split_files/text_encoders/qwen_3_4b.safetensors',
          bytes: 8044982048,
          field: 'llm',
        },
      ],
      defaults: { steps: 8, cfg_scale: 1, width: 1024, height: 1024 },
      ranges: { steps: [1, 50], dims: [256, 2048], dim_multiple: 16 },
      capabilities: {
        negative_prompt: false,
        guidance: false,
        workflows: ['create'],
      },
    })
  })

  it('accepts safe GGUF subfolders and drops unsafe transformer paths', () => {
    const parsed = sanitizeDiffusionFamily(
      family({
        transformer: {
          repo: 'unsloth/Z-Image-Turbo-GGUF',
          quants: [
            {
              id: 'q4_k_m',
              label: 'Q4_K_M',
              filename: 'ok-Q4_K_M.gguf',
              bytes: 1,
            },
            {
              id: 'q5_k_m',
              label: 'Q5_K_M',
              filename: '../escape.gguf',
              bytes: 1,
            },
            { id: 'q6_k', label: 'Q6_K', filename: 'sub/dir.gguf', bytes: 1 },
            {
              id: 'q8_0',
              label: 'Q8_0',
              filename: 'weights.safetensors',
              bytes: 1,
            },
            { id: 'f16', label: 'F16', filename: 'weights.gguf', bytes: 0 },
          ],
        },
      })
    )
    expect(parsed?.transformer.quants.map((q) => q.id)).toEqual([
      'q4_k_m',
      'q6_k',
    ])
  })

  it('rejects the whole family when a side file could escape the models root', () => {
    expect(
      sanitizeDiffusionFamily(
        family({
          vae: {
            repo: 'unsloth/x',
            filename: 'split_files/../../ae.safetensors',
            bytes: 1,
          },
        })
      )
    ).toBeNull()
    expect(
      sanitizeDiffusionFamily(
        family({
          text_encoders: [
            { repo: 'unsloth/x', filename: 'enc.bin', bytes: 1, field: 'llm' },
          ],
        })
      )
    ).toBeNull()
    expect(
      sanitizeDiffusionFamily(
        family({
          text_encoders: [
            { repo: 'unsloth/x', filename: 'enc.safetensors', bytes: 1 },
          ],
        })
      )
    ).toBeNull()
  })

  it('rejects unknown ids, bad bytes and malformed ranges', () => {
    expect(sanitizeDiffusionFamily(family({ id: 'sdxl' }))).toBeNull()
    expect(
      sanitizeDiffusionFamily(
        family({
          vae: {
            repo: 'unsloth/x',
            filename: 'ae.safetensors',
            bytes: '335304388',
          },
        })
      )
    ).toBeNull()
    expect(
      sanitizeDiffusionFamily(
        family({
          ranges: { steps: [50, 1], dims: [256, 2048], dim_multiple: 16 },
        })
      )
    ).toBeNull()
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

  it('allows safe transformer subfolders without allowing traversal', () => {
    expect(isSafeQuantFilename('TURBO/Krea-2-Turbo-Q4_K_M.gguf')).toBe(true)
    expect(isSafeQuantFilename('../Krea-2-Turbo-Q4_K_M.gguf')).toBe(false)
    expect(isSafeQuantFilename('TURBO/../weights.gguf')).toBe(false)
    expect(isSafeQuantFilename('/TURBO/weights.gguf')).toBe(false)
    expect(isSafeQuantFilename('TURBO/weights.safetensors')).toBe(false)
  })

  it('accepts the Qwen 2.1 vision companion and editing workflows', () => {
    const parsed = sanitizeDiffusionFamily(
      family({
        id: 'qwen-image-2.1',
        text_encoders: [
          {
            repo: 'Qwen/Qwen3-VL-8B-Instruct-GGUF',
            filename: 'Qwen3VL-8B-Instruct-Q4_K_M.gguf',
            bytes: 5_027_784_800,
            field: 'llm',
          },
          {
            repo: 'Qwen/Qwen3-VL-8B-Instruct-GGUF',
            filename: 'mmproj-Qwen3VL-8B-Instruct-F16.gguf',
            bytes: 1_159_029_824,
            field: 'llm_vision',
          },
        ],
        capabilities: {
          negative_prompt: false,
          guidance: false,
          workflows: ['create', 'reference', 'edit'],
        },
      })
    )

    expect(parsed?.text_encoders.map((entry) => entry.field)).toEqual([
      'llm',
      'llm_vision',
    ])
    expect(parsed?.capabilities.workflows).toEqual([
      'create',
      'reference',
      'edit',
    ])
  })

  it('normalizes Qwen 2.1 to a 1024px default without narrowing explicit sizes', () => {
    const qwen = sanitizeDiffusionFamily(
      family({
        id: 'qwen-image-2.1',
        defaults: {
          steps: 40,
          cfg_scale: 6,
          sampling_method: 'euler',
          width: 2048,
          height: 2048,
        },
        ranges: { steps: [1, 50], dims: [256, 2048], dim_multiple: 32 },
      })
    )
    const other = sanitizeDiffusionFamily(
      family({ defaults: { steps: 8, cfg_scale: 1, width: 2048, height: 1536 } })
    )

    expect(qwen?.defaults).toMatchObject({ width: 1024, height: 1024 })
    expect(qwen?.ranges.dims).toEqual([256, 2048])
    expect(other?.defaults).toMatchObject({ width: 2048, height: 1536 })
  })
})

describe('baseline and lookups', () => {
  it('keeps remote definitions and appends bundled families a released client knows', () => {
    const remote = parseDiffusionCatalog(manifest())
    const merged = mergeBundledDiffusionFamilies(remote)
    expect(merged.families[0].name).toBe('Z-Image Turbo')
    expect(merged.families.map((entry) => entry.id)).toContain(
      'flux.1-uncensored'
    )
  })

  it('bundles a catalog that passes its own validation', () => {
    const baseline = getBaselineDiffusionCatalog()
    expect(baseline.schema_version).toBe(SUPPORTED_SCHEMA_VERSION)
    expect(baseline.families.map((f) => f.id)).toEqual([
      'z-image',
      'flux.2-klein',
      'flux.1',
      'flux.1-uncensored',
      'flux.1-abliterated',
      'flux.1-nsfw-realism',
      'flux.1-krea',
      'krea-2-turbo',
      'qwen-image',
      'qwen-image-2.1',
      'ltx-2',
      'wan2.2-ti2v-5b',
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

  it('rejects the incompatible Frankenstein checkpoint from remote catalogs', () => {
    const raw = manifest()
    raw.families[0].id = 'flux.1-frankenstein'

    expect(() => parseDiffusionCatalog(raw)).toThrow(
      'Diffusion catalog carries no usable family'
    )
  })

  it('uses CFG rather than distilled guidance for NSFW Realism', () => {
    const family = findFamily(
      getBaselineDiffusionCatalog(),
      'flux.1-nsfw-realism'
    )

    expect(family?.defaults.cfg_scale).toBe(3.5)
    expect(family?.defaults.guidance).toBeUndefined()
    expect(family?.capabilities).toMatchObject({
      negative_prompt: true,
      guidance: false,
    })
  })

  it('bundles the verified non-commercial Qwen-Image-2.1 definition', () => {
    const family = findFamily(
      getBaselineDiffusionCatalog(),
      'qwen-image-2.1'
    )

    expect(family).toMatchObject({
      name: 'Qwen-Image-2.1',
      license: 'qwen-research-non-commercial',
      description: expect.stringContaining('NON-COMMERCIAL ONLY'),
      defaults: {
        steps: 40,
        cfg_scale: 6,
        sampling_method: 'euler',
        width: 1024,
        height: 1024,
      },
      ranges: {
        steps: [1, 50],
        dims: [256, 2048],
        dim_multiple: 32,
      },
      capabilities: {
        negative_prompt: false,
        guidance: false,
        workflows: ['create', 'reference', 'edit'],
      },
    })
    expect(family?.transformer.quants).toEqual([
      {
        id: 'q4_k',
        label: 'Q4_K',
        filename: 'qwen_image_2.1-Q4_K.gguf',
        bytes: 4_197_494_816,
        sha256:
          '29f9c83c249ff0292fb2943fceddfa2319b446601866c82a4f8be062abea72c2',
        recommended: true,
      },
    ])
  })

  it('bundles the verified Krea 2 Turbo Community License definition', () => {
    const family = findFamily(getBaselineDiffusionCatalog(), 'krea-2-turbo')

    expect(family).toMatchObject({
      name: 'Krea 2 Turbo',
      license: 'krea-2-community-license',
      gated: true,
      description: expect.stringContaining('Krea 2 Community License'),
      defaults: {
        steps: 8,
        cfg_scale: 1,
        sampling_method: 'euler',
        width: 1024,
        height: 1024,
      },
      ranges: {
        steps: [1, 20],
        dims: [512, 2048],
        dim_multiple: 16,
      },
      capabilities: {
        negative_prompt: false,
        guidance: false,
        workflows: ['create'],
      },
      vae: {
        repo: 'Comfy-Org/Wan_2.1_ComfyUI_repackaged',
        filename: 'split_files/vae/wan_2.1_vae.safetensors',
        bytes: 253_815_318,
        sha256:
          '2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b',
      },
      text_encoders: [
        {
          repo: 'Qwen/Qwen3-VL-4B-Instruct-GGUF',
          filename: 'Qwen3VL-4B-Instruct-Q4_K_M.gguf',
          bytes: 2_497_281_664,
          sha256:
            '66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a',
          field: 'llm',
        },
      ],
    })
    expect(family?.transformer).toEqual({
      repo: 'realrebelai/KREA-2_GGUFs',
      quants: [
        {
          id: 'q3_k_m',
          label: 'Q3_K_M',
          filename: 'TURBO/Krea-2-Turbo-Q3_K_M.gguf',
          bytes: 5_514_578_016,
          sha256:
            '9a8917ac175e0287d86f43da7d520ee0efe4a24f5250d9cd7ae0b0abf4ef5f62',
        },
        {
          id: 'q4_k_m',
          label: 'Q4_K_M',
          filename: 'TURBO/Krea-2-Turbo-Q4_K_M.gguf',
          bytes: 7_216_993_376,
          sha256:
            '273a98be1afe317bc7228403b6434647eaf866cebe6aff1980c401b950473807',
          recommended: true,
        },
        {
          id: 'q5_k_s',
          label: 'Q5_K_S',
          filename: 'TURBO/Krea-2-Turbo-Q5_K_S.gguf',
          bytes: 8_819_266_656,
          sha256:
            '2d9a6bfb1b9ef512b040af72b59ce8c4a564f834a083747f3a6e7d3781e8b6dd',
        },
      ],
    })
  })
})

describe('video families', () => {
  const raw = (family: unknown) => JSON.parse(JSON.stringify(family)) as Record<string, unknown>

  it('keeps LTX-2.3 and Wan 2.2 verbatim: the audio VAE, the connectors, the sigma schedule and the video block', () => {
    expect(sanitizeDiffusionFamily(raw(LTX_2))).toEqual(LTX_2)
    expect(sanitizeDiffusionFamily(raw(WAN_22))).toEqual(WAN_22)
    const ltx = sanitizeDiffusionFamily(raw(LTX_2))!
    expect(ltx.text_encoders.map((t) => t.field)).toEqual(['llm', 'embeddings_connectors'])
    expect(ltx.audio_vae?.filename).toBe('vae/ltx-2.3-22b-distilled_audio_vae.safetensors')
    expect(ltx.defaults.sigmas).toHaveLength(8)
    expect(ltx.video?.frame_range).toEqual([9, 257])
  })

  it('drops a video family whose video block is missing or off its own lattice, grid or range', () => {
    const withVideo = (video: unknown) => ({ ...raw(LTX_2), video })
    expect(sanitizeDiffusionFamily({ ...raw(LTX_2), video: undefined })).toBeNull()
    expect(sanitizeDiffusionFamily(withVideo('x'))).toBeNull()
    const video = LTX_2.video!
    expect(sanitizeDiffusionFamily(withVideo({ ...video, frames: 120 }))).toBeNull()
    expect(sanitizeDiffusionFamily(withVideo({ ...video, frames: 265 }))).toBeNull()
    expect(sanitizeDiffusionFamily(withVideo({ ...video, fps: 0 }))).toBeNull()
    expect(sanitizeDiffusionFamily(withVideo({ ...video, frame_step: 0 }))).toBeNull()
    expect(sanitizeDiffusionFamily(withVideo({ ...video, frame_offset: -1 }))).toBeNull()
    expect(sanitizeDiffusionFamily(withVideo({ ...video, frame_range: [9] }))).toBeNull()
    expect(sanitizeDiffusionFamily(withVideo({ ...video, resolution_presets: [] }))).toBeNull()
    expect(sanitizeDiffusionFamily(withVideo({ ...video, resolution_presets: [[770, 512]] }))).toBeNull()
    expect(sanitizeDiffusionFamily(withVideo({ ...video, resolution_presets: [[2048, 512]] }))).toBeNull()
    expect(sanitizeDiffusionFamily(withVideo({ ...video, resolution_presets: [[768]] }))).toBeNull()
    expect(sanitizeDiffusionFamily(withVideo({ ...video, resolution_presets: 'x' }))).toBeNull()
  })

  it('ignores a video block on an image family, and refuses a bad audio VAE or sigma schedule', () => {
    const image = sanitizeDiffusionFamily({ ...family(), video: LTX_2.video })
    expect(image).not.toBeNull()
    expect(image).not.toHaveProperty('video')
    expect(sanitizeDiffusionFamily({ ...raw(LTX_2), audio_vae: { repo: 'x' } })).toBeNull()
    expect(
      sanitizeDiffusionFamily({ ...raw(LTX_2), defaults: { ...LTX_2.defaults, sigmas: [1, 0] } })
    ).toBeNull()
    expect(
      sanitizeDiffusionFamily({ ...raw(LTX_2), defaults: { ...LTX_2.defaults, sigmas: [] } })
    ).toBeNull()
    expect(
      sanitizeDiffusionFamily({ ...raw(LTX_2), defaults: { ...LTX_2.defaults, sigmas: 'x' } })
    ).toBeNull()
    // A text encoder with a field the client does not know is refused, as before.
    expect(
      sanitizeDiffusionFamily({
        ...raw(LTX_2),
        text_encoders: [{ ...LTX_2.text_encoders[0], field: 'gemma' }],
      })
    ).toBeNull()
  })

  it('bundles the two video families with their video blocks', () => {
    const baseline = getBaselineDiffusionCatalog()
    const ltx = findFamily(baseline, 'ltx-2')
    const wan = findFamily(baseline, 'wan2.2-ti2v-5b')
    expect(ltx?.modality).toBe('video')
    expect(ltx?.video).toMatchObject({ fps: 24, frame_step: 8, frame_offset: 1, frames: 121 })
    expect(ltx?.audio_vae?.repo).toBe('unsloth/LTX-2.3-GGUF')
    expect(ltx?.text_encoders.map((t) => t.field)).toEqual(['llm', 'embeddings_connectors'])
    expect(ltx?.defaults.sigmas).toEqual([1, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875])
    expect(wan?.video).toMatchObject({ fps: 24, frame_step: 4, frame_offset: 1, frames: 121 })
    expect(wan?.capabilities.negative_prompt).toBe(true)
    expect(findQuant(ltx!, 'q4_k_m')?.recommended).toBe(true)
  })
})

/**
 * Tests for the remote recommended-models registry loader.
 *
 * Covers the public surface in `services/recommended-models-registry.ts`:
 *   - Successful fetch caches the manifest.
 *   - Fresh cache is preferred over a network round-trip.
 *   - Network failures fall back to cached / baseline data.
 *   - schema_version mismatches are rejected.
 *   - Malformed payloads are rejected.
 *   - Stale cache is eligible only as a network-failure fallback.
 *   - Platform filter helper (`filterRecommendationsForPlatform`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}))

import {
  CACHE_TTL_MS,
  clearRegistryCache,
  filterRecommendationsForPlatform,
  getCachedManifest,
  getRecommendationsOrFallback,
  isCacheFresh,
  selectTierRecommendations,
  SUPPORTED_SCHEMA_VERSION,
  type Recommendation,
} from '../recommended-models-registry'
import {
  BASELINE_RECOMMENDED_MODELS,
  BASELINE_TIER_RECOMMENDATIONS,
} from '@/constants/models'
import { HARDWARE_TIERS } from '@/lib/hardware-tier'

const REMOTE_URL = 'https://example.test/recommended.json'

const buildManifest = (overrides: Record<string, unknown> = {}) => ({
  schema_version: SUPPORTED_SCHEMA_VERSION,
  updated_at: '2026-04-30T00:00:00Z',
  recommendations: [
    {
      model_name: 'unsloth/gemma-4-E4B-it-GGUF',
      description_key: 'hub:recEverydayUse',
    },
    {
      model_name: 'mlx-community/Qwen3.5-9B-MLX-4bit',
      description_key: 'hub:recForMlx',
      platforms: ['macos'],
    },
  ],
  ...overrides,
})

const mockFetchSuccess = (body: unknown) => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  }))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

const mockFetchFailure = (error: unknown) => {
  const fetchMock = vi.fn(async () => {
    throw error
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('recommended-models-registry loader', () => {
  beforeEach(() => {
    clearRegistryCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches a valid manifest and exposes its recommendations', async () => {
    mockFetchSuccess(buildManifest())

    const result = await getRecommendationsOrFallback({ url: REMOTE_URL })

    expect(result.source).toBe('remote')
    expect(result.recommendations.map((r) => r.model_name)).toEqual([
      'unsloth/gemma-4-E4B-it-GGUF',
      'mlx-community/Qwen3.5-9B-MLX-4bit',
    ])
    expect(result.recommendations[1].platforms).toEqual(['macos'])
  })

  it('writes the cache after a successful fetch', async () => {
    mockFetchSuccess(buildManifest())

    await getRecommendationsOrFallback({ url: REMOTE_URL })

    const cached = getCachedManifest()
    expect(cached).not.toBeNull()
    expect(cached!.manifest.recommendations).toHaveLength(2)
    expect(isCacheFresh(cached)).toBe(true)
  })

  it('serves cached data on subsequent calls within TTL', async () => {
    const fetchMock = mockFetchSuccess(buildManifest())

    await getRecommendationsOrFallback({ url: REMOTE_URL })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const second = await getRecommendationsOrFallback({ url: REMOTE_URL })
    expect(second.source).toBe('cache')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('forces a fetch when force=true even if cache is fresh', async () => {
    const fetchMock = mockFetchSuccess(buildManifest())

    await getRecommendationsOrFallback({ url: REMOTE_URL })
    await getRecommendationsOrFallback({ url: REMOTE_URL, force: true })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to cached data when the network fails', async () => {
    mockFetchSuccess(buildManifest())
    await getRecommendationsOrFallback({ url: REMOTE_URL })

    mockFetchFailure(new Error('offline'))
    const result = await getRecommendationsOrFallback({
      url: REMOTE_URL,
      force: true,
    })

    expect(result.source).toBe('cache')
    expect(result.error).toBe('offline')
    expect(
      result.recommendations.find(
        (r) => r.model_name === 'unsloth/gemma-4-E4B-it-GGUF'
      )
    ).toBeDefined()
  })

  it('falls back to baseline when no cache and the network fails', async () => {
    mockFetchFailure(new Error('boom'))

    const result = await getRecommendationsOrFallback({ url: REMOTE_URL })

    expect(result.source).toBe('baseline')
    expect(result.recommendations.map((r) => r.model_name)).toEqual(
      BASELINE_RECOMMENDED_MODELS.map((r) => r.model_name)
    )
    expect(result.error).toBe('boom')
  })

  it('rejects manifests with a newer schema_version than supported', async () => {
    mockFetchSuccess(
      buildManifest({ schema_version: SUPPORTED_SCHEMA_VERSION + 1 })
    )

    const result = await getRecommendationsOrFallback({ url: REMOTE_URL })
    expect(result.source).toBe('baseline')
    expect(result.error).toMatch(/schema_version/)
  })

  it('rejects manifests with a malformed payload', async () => {
    mockFetchSuccess({ not: 'a manifest' })

    const result = await getRecommendationsOrFallback({ url: REMOTE_URL })
    expect(result.source).toBe('baseline')
    expect(result.error).toMatch(/not a valid manifest/)
  })

  it('drops invalid recommendation entries while keeping good ones', async () => {
    mockFetchSuccess(
      buildManifest({
        recommendations: [
          { model_name: 'good/one', description_key: 'hub:recEverydayUse' },
          { model_name: '', description_key: 'hub:recEverydayUse' },
          { model_name: 'bad/key', description_key: 'NOT_HUB_PREFIXED' },
          {
            model_name: 'platform/coerced',
            description_key: 'hub:recForMlx',
            platforms: ['macos', 'aix', 7],
          },
        ],
      })
    )

    const result = await getRecommendationsOrFallback({ url: REMOTE_URL })
    expect(result.source).toBe('remote')
    expect(result.recommendations.map((r) => r.model_name)).toEqual([
      'good/one',
      'platform/coerced',
    ])
    expect(result.recommendations[1].platforms).toEqual(['macos'])
  })

  it('treats a stale cache as eligible for fallback only', async () => {
    mockFetchSuccess(buildManifest())
    await getRecommendationsOrFallback({ url: REMOTE_URL })

    // Backdate the cache so isCacheFresh returns false.
    const tsKey = 'jan_recommended_models_cache_ts_v1'
    window.localStorage.setItem(tsKey, String(Date.now() - CACHE_TTL_MS - 1000))

    const cached = getCachedManifest()
    expect(isCacheFresh(cached)).toBe(false)

    mockFetchFailure(new Error('still offline'))
    const result = await getRecommendationsOrFallback({ url: REMOTE_URL })
    expect(result.source).toBe('cache')
  })
})

describe('filterRecommendationsForPlatform', () => {
  const recs: Recommendation[] = [
    {
      model_name: 'universal/one',
      description_key: 'hub:recEverydayUse',
    },
    {
      model_name: 'mac/only',
      description_key: 'hub:recForMlx',
      platforms: ['macos'],
    },
    {
      model_name: 'win-linux/only',
      description_key: 'hub:recFinetuningChat',
      platforms: ['windows', 'linux'],
    },
    {
      model_name: 'disabled/everywhere',
      description_key: 'hub:recEverydayUse',
      active: false,
    },
  ]

  it('keeps universal entries on every platform', () => {
    expect(
      filterRecommendationsForPlatform(recs, 'macos').map((r) => r.model_name)
    ).toContain('universal/one')
    expect(
      filterRecommendationsForPlatform(recs, 'windows').map((r) => r.model_name)
    ).toContain('universal/one')
    expect(
      filterRecommendationsForPlatform(recs, 'linux').map((r) => r.model_name)
    ).toContain('universal/one')
  })

  it('hides macOS-only entries on Windows and Linux', () => {
    const winNames = filterRecommendationsForPlatform(recs, 'windows').map(
      (r) => r.model_name
    )
    const linuxNames = filterRecommendationsForPlatform(recs, 'linux').map(
      (r) => r.model_name
    )
    expect(winNames).not.toContain('mac/only')
    expect(linuxNames).not.toContain('mac/only')
  })

  it('hides Windows/Linux-only entries on macOS', () => {
    const macNames = filterRecommendationsForPlatform(recs, 'macos').map(
      (r) => r.model_name
    )
    expect(macNames).not.toContain('win-linux/only')
  })

  it('always drops entries with active: false', () => {
    for (const os of ['macos', 'windows', 'linux'] as const) {
      const names = filterRecommendationsForPlatform(recs, os).map(
        (r) => r.model_name
      )
      expect(names).not.toContain('disabled/everywhere')
    }
  })
})

describe('per-tier recommendations and quant pins', () => {
  beforeEach(() => {
    clearRegistryCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const tieredManifest = () =>
    buildManifest({
      tiers: {
        unified_8: [
          {
            model_name: 'LiquidAI/LFM2.5-2.6B-GGUF',
            description_key: 'hub:recEverydayUse',
            quant: 'Q4_K_M',
          },
        ],
        vram_16_plus: [
          {
            model_name: 'unsloth/gemma-4-12B-it-qat-GGUF',
            description_key: 'hub:recVisionKnowledge',
            quant: 'Q4_K_XL',
            mmproj_quant: 'F16',
          },
        ],
      },
    })

  it('carries the tier lists and their quant pins through a fetch', async () => {
    mockFetchSuccess(tieredManifest())

    const result = await getRecommendationsOrFallback({ url: REMOTE_URL })

    expect(result.tiers.unified_8?.map((r) => r.model_name)).toEqual([
      'LiquidAI/LFM2.5-2.6B-GGUF',
    ])
    expect(result.tiers.vram_16_plus?.[0].quant).toBe('Q4_K_XL')
    expect(result.tiers.vram_16_plus?.[0].mmproj_quant).toBe('F16')
  })

  it('survives the cache round-trip', async () => {
    mockFetchSuccess(tieredManifest())
    await getRecommendationsOrFallback({ url: REMOTE_URL })

    const cached = getCachedManifest()
    expect(cached?.manifest.tiers?.vram_16_plus?.[0].quant).toBe('Q4_K_XL')
  })

  it('reports no tier lists when the manifest has none', async () => {
    mockFetchSuccess(buildManifest())

    const result = await getRecommendationsOrFallback({ url: REMOTE_URL })

    expect(result.tiers).toEqual({})
  })

  it('drops keys that are not tiers this build knows about', async () => {
    // The tier vocabulary is a release-time contract. A manifest written for a
    // newer one must leave this client on its bundled ladder, not on a rung it
    // cannot interpret.
    mockFetchSuccess(
      buildManifest({
        tiers: {
          unified_8: [
            {
              model_name: 'LiquidAI/LFM2.5-2.6B-GGUF',
              description_key: 'hub:recEverydayUse',
            },
          ],
          npu_42: [
            {
              model_name: 'Someone/Future-GGUF',
              description_key: 'hub:recEverydayUse',
            },
          ],
        },
      })
    )

    const result = await getRecommendationsOrFallback({ url: REMOTE_URL })

    expect(Object.keys(result.tiers)).toEqual(['unified_8'])
  })

  it('drops quant pins that are not plain quant tokens', async () => {
    // These are used to pick a file to download, so a malformed manifest must
    // not be able to smuggle a value through.
    mockFetchSuccess(
      buildManifest({
        tiers: {
          vram_4: [
            {
              model_name: 'LiquidAI/LFM2.5-2.6B-GGUF',
              description_key: 'hub:recEverydayUse',
              quant: '../../etc/passwd',
            },
            {
              model_name: 'LiquidAI/Other-GGUF',
              description_key: 'hub:recEverydayUse',
              quant: 12345,
            },
          ],
        },
      })
    )

    const result = await getRecommendationsOrFallback({ url: REMOTE_URL })

    expect(result.tiers.vram_4).toHaveLength(2)
    expect(result.tiers.vram_4?.[0].quant).toBeUndefined()
    expect(result.tiers.vram_4?.[1].quant).toBeUndefined()
  })

  it('normalises a lowercase pin to upper case', async () => {
    mockFetchSuccess(
      buildManifest({
        tiers: {
          vram_4: [
            {
              model_name: 'LiquidAI/LFM2.5-2.6B-GGUF',
              description_key: 'hub:recEverydayUse',
              quant: 'q4_k_m',
            },
          ],
        },
      })
    )

    const result = await getRecommendationsOrFallback({ url: REMOTE_URL })

    expect(result.tiers.vram_4?.[0].quant).toBe('Q4_K_M')
  })

  it('ignores the superseded low-spec list without choking on it', async () => {
    // It stays in the published manifest for clients shipped before `tiers`
    // existed. This client must read past it, not fail on it.
    mockFetchSuccess(
      buildManifest({
        low_spec_recommendations: [
          {
            model_name: 'LiquidAI/LFM2.5-VL-450M-GGUF',
            description_key: 'hub:recVisionKnowledge',
            quant: 'Q8_0',
          },
        ],
      })
    )

    const result = await getRecommendationsOrFallback({ url: REMOTE_URL })

    expect(result.source).toBe('remote')
    expect(result.recommendations).toHaveLength(2)
    expect(result.tiers).toEqual({})
  })

  it('loads cleanly when the manifest carries an unknown top-level key', async () => {
    // The v1-compatibility contract: this is exactly how a client built before
    // `tiers` existed sees the new manifest.
    mockFetchSuccess(buildManifest({ some_future_key: { anything: true } }))

    const result = await getRecommendationsOrFallback({ url: REMOTE_URL })

    expect(result.source).toBe('remote')
    expect(result.recommendations).toHaveLength(2)
  })

  it('falls back to the bundled baseline with no tier overrides', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await getRecommendationsOrFallback({ url: REMOTE_URL })

    expect(result.source).toBe('baseline')
    expect(result.recommendations.map((r) => r.model_name)).toEqual(
      BASELINE_RECOMMENDED_MODELS.map((r) => r.model_name)
    )
    // Empty rather than a copy of the ladder: `selectTierRecommendations` is
    // where the bundled ladder is applied, per tier, so a partial manifest can
    // override one rung and inherit the rest.
    expect(result.tiers).toEqual({})
  })
})

describe('selectTierRecommendations', () => {
  const override: Recommendation[] = [
    {
      model_name: 'Someone/Override-GGUF',
      description_key: 'hub:recEverydayUse',
    },
  ]

  it('prefers the manifest entry for that tier', () => {
    expect(
      selectTierRecommendations({ unified_16: override }, 'unified_16').map(
        (r) => r.model_name
      )
    ).toEqual(['Someone/Override-GGUF'])
  })

  it('falls back per tier, not wholesale', () => {
    // A manifest that overrides one rung must leave every other rung on the
    // bundled ladder rather than emptying the picker.
    expect(
      selectTierRecommendations({ unified_16: override }, 'cpu_only').map(
        (r) => r.model_name
      )
    ).toEqual(BASELINE_TIER_RECOMMENDATIONS.cpu_only.map((r) => r.model_name))
  })

  it('falls back to the bundled ladder when there are no tier lists at all', () => {
    for (const tier of HARDWARE_TIERS) {
      expect(selectTierRecommendations(undefined, tier)).toEqual(
        BASELINE_TIER_RECOMMENDATIONS[tier]
      )
    }
  })

  it('treats an empty tier list as absent', () => {
    expect(selectTierRecommendations({ vram_8: [] }, 'vram_8')).toEqual(
      BASELINE_TIER_RECOMMENDATIONS.vram_8
    )
  })

  it('has a bundled entry for every tier, so no machine gets an empty picker', () => {
    for (const tier of HARDWARE_TIERS) {
      expect(BASELINE_TIER_RECOMMENDATIONS[tier].length).toBeGreaterThan(0)
    }
  })
})

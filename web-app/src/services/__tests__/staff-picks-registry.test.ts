/**
 * Tests for the remote staff-picks registry loader.
 *
 * Covers the public surface in `services/staff-picks-registry.ts`:
 *   - Successful fetch caches the manifest.
 *   - Fresh cache is preferred over a network round-trip.
 *   - Network failures fall back to cached / baseline data.
 *   - schema_version mismatches are rejected.
 *   - Malformed payloads and malformed entries are rejected.
 *   - Stale cache is eligible only as a network-failure fallback.
 *   - A hung request resolves through the hard timeout.
 *   - Cache keys stay isolated from the production recommended-models cache.
 *   - Platform filter + ordering helper (`filterStaffPicksForPlatform`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}))

import {
  CACHE_TTL_MS,
  clearStaffPicksCache,
  filterStaffPicksForPlatform,
  getCachedManifest,
  getStaffPicksOrFallback,
  isCacheFresh,
  sanitizePick,
  SUPPORTED_SCHEMA_VERSION,
  type StaffPick,
} from '../staff-picks-registry'
import { BASELINE_STAFF_PICKS } from '@/constants/staff-picks'

const REMOTE_URL = 'https://example.test/staff-picks.json'

const buildManifest = (overrides: Record<string, unknown> = {}) => ({
  schema_version: SUPPORTED_SCHEMA_VERSION,
  updated_at: '2026-08-06T00:00:00Z',
  picks: [
    {
      model_name: 'AtomicChat/Qwen3.5-4B-GGUF',
      title: 'Qwen3.5 4B',
      summary: 'Compact all-rounder.',
      description_key: 'hub:recEverydayUse',
      icon: 'qwen',
      categories: ['general', 'compact'],
      order: 10,
    },
    {
      model_name: 'mlx-community/Qwen3.5-9B-MLX-4bit',
      description_key: 'hub:recForMlx',
      platforms: ['macos'],
      order: 20,
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

describe('staff-picks-registry loader', () => {
  beforeEach(() => {
    clearStaffPicksCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches a valid manifest and exposes its picks', async () => {
    mockFetchSuccess(buildManifest())

    const result = await getStaffPicksOrFallback({ url: REMOTE_URL })

    expect(result.source).toBe('remote')
    expect(result.picks.map((p) => p.model_name)).toEqual([
      'AtomicChat/Qwen3.5-4B-GGUF',
      'mlx-community/Qwen3.5-9B-MLX-4bit',
    ])
    expect(result.picks[0].title).toBe('Qwen3.5 4B')
    expect(result.picks[0].categories).toEqual(['general', 'compact'])
    expect(result.picks[1].platforms).toEqual(['macos'])
  })

  it('writes the cache after a successful fetch', async () => {
    mockFetchSuccess(buildManifest())

    await getStaffPicksOrFallback({ url: REMOTE_URL })

    const cached = getCachedManifest()
    expect(cached).not.toBeNull()
    expect(cached!.manifest.picks).toHaveLength(2)
    expect(isCacheFresh(cached)).toBe(true)
  })

  it('serves cached data on subsequent calls within TTL', async () => {
    const fetchMock = mockFetchSuccess(buildManifest())

    await getStaffPicksOrFallback({ url: REMOTE_URL })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const second = await getStaffPicksOrFallback({ url: REMOTE_URL })
    expect(second.source).toBe('cache')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('forces a fetch with a cache-buster when force=true', async () => {
    const fetchMock = mockFetchSuccess(buildManifest())

    await getStaffPicksOrFallback({ url: REMOTE_URL })
    await getStaffPicksOrFallback({ url: REMOTE_URL, force: true })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const forcedUrl = fetchMock.mock.calls[1][0] as unknown as string
    expect(forcedUrl).toMatch(/[?&]t=\d+/)
  })

  it('falls back to cached data when the network fails', async () => {
    mockFetchSuccess(buildManifest())
    await getStaffPicksOrFallback({ url: REMOTE_URL })

    mockFetchFailure(new Error('offline'))
    const result = await getStaffPicksOrFallback({
      url: REMOTE_URL,
      force: true,
    })

    expect(result.source).toBe('cache')
    expect(result.error).toBe('offline')
    expect(
      result.picks.find((p) => p.model_name === 'AtomicChat/Qwen3.5-4B-GGUF')
    ).toBeDefined()
  })

  it('falls back to baseline when no cache and the network fails', async () => {
    mockFetchFailure(new Error('boom'))

    const result = await getStaffPicksOrFallback({ url: REMOTE_URL })

    expect(result.source).toBe('baseline')
    expect(result.picks.map((p) => p.model_name)).toEqual(
      BASELINE_STAFF_PICKS.map((p) => p.model_name)
    )
    expect(result.error).toBe('boom')
  })

  it('rejects manifests with a newer schema_version than supported', async () => {
    mockFetchSuccess(
      buildManifest({ schema_version: SUPPORTED_SCHEMA_VERSION + 1 })
    )

    const result = await getStaffPicksOrFallback({ url: REMOTE_URL })
    expect(result.source).toBe('baseline')
    expect(result.error).toMatch(/schema_version/)
  })

  it('rejects manifests with a malformed payload', async () => {
    mockFetchSuccess({ not: 'a manifest' })

    const result = await getStaffPicksOrFallback({ url: REMOTE_URL })
    expect(result.source).toBe('baseline')
    expect(result.error).toMatch(/not a valid manifest/)
  })

  it('rejects a manifest whose picks field is not an array', async () => {
    mockFetchSuccess(buildManifest({ picks: { nope: true } }))

    const result = await getStaffPicksOrFallback({ url: REMOTE_URL })
    expect(result.source).toBe('baseline')
    expect(result.error).toMatch(/not a valid manifest/)
  })

  it('drops invalid pick entries while keeping good ones', async () => {
    mockFetchSuccess(
      buildManifest({
        picks: [
          { model_name: 'good/one', description_key: 'hub:recEverydayUse' },
          { model_name: '', description_key: 'hub:recEverydayUse' },
          null,
          'not-an-object',
          {
            model_name: 'coerced/entry',
            description_key: 'NOT_HUB_PREFIXED',
            platforms: ['macos', 'aix', 7],
            categories: ['coding', 'astrology'],
            order: 'soon',
          },
        ],
      })
    )

    const result = await getStaffPicksOrFallback({ url: REMOTE_URL })
    expect(result.source).toBe('remote')
    expect(result.picks.map((p) => p.model_name)).toEqual([
      'good/one',
      'coerced/entry',
    ])
    const coerced = result.picks[1]
    expect(coerced.platforms).toEqual(['macos'])
    expect(coerced.categories).toEqual(['coding'])
    expect(coerced.description_key).toBeUndefined()
    expect(coerced.order).toBeUndefined()
  })

  it('treats a stale cache as eligible for fallback only', async () => {
    mockFetchSuccess(buildManifest())
    await getStaffPicksOrFallback({ url: REMOTE_URL })

    // Backdate the cache so isCacheFresh returns false.
    window.localStorage.setItem(
      'atomic_staff_picks_cache_ts_v1',
      String(Date.now() - CACHE_TTL_MS - 1000)
    )

    const cached = getCachedManifest()
    expect(isCacheFresh(cached)).toBe(false)

    mockFetchFailure(new Error('still offline'))
    const result = await getStaffPicksOrFallback({ url: REMOTE_URL })
    expect(result.source).toBe('cache')
  })

  it('resolves through the hard timeout when the request hangs', async () => {
    globalThis.fetch = vi.fn(
      () => new Promise(() => {})
    ) as unknown as typeof fetch

    const result = await getStaffPicksOrFallback({
      url: REMOTE_URL,
      timeoutMs: 10,
    })

    expect(result.source).toBe('baseline')
    expect(result.error).toMatch(/timed out/)
  })

  it('never touches the production recommended-models cache keys', async () => {
    const recommendedPayload = JSON.stringify({ sentinel: true })
    window.localStorage.setItem(
      'jan_recommended_models_cache_v1',
      recommendedPayload
    )
    window.localStorage.setItem('jan_recommended_models_cache_ts_v1', '123')

    mockFetchSuccess(buildManifest())
    await getStaffPicksOrFallback({ url: REMOTE_URL })
    clearStaffPicksCache()

    expect(
      window.localStorage.getItem('jan_recommended_models_cache_v1')
    ).toBe(recommendedPayload)
    expect(
      window.localStorage.getItem('jan_recommended_models_cache_ts_v1')
    ).toBe('123')

    window.localStorage.removeItem('jan_recommended_models_cache_v1')
    window.localStorage.removeItem('jan_recommended_models_cache_ts_v1')
  })
})

describe('sanitizePick', () => {
  it('rejects non-objects and entries without a model name', () => {
    expect(sanitizePick(null)).toBeNull()
    expect(sanitizePick('nope')).toBeNull()
    expect(sanitizePick({})).toBeNull()
    expect(sanitizePick({ model_name: '' })).toBeNull()
  })

  it('keeps only known optional fields', () => {
    expect(
      sanitizePick({
        model_name: 'a/b',
        title: 'Title',
        summary: 'Summary',
        icon: 'qwen',
        order: 5,
        active: false,
        rogue_field: 'dropped',
      })
    ).toEqual({
      model_name: 'a/b',
      title: 'Title',
      summary: 'Summary',
      icon: 'qwen',
      order: 5,
      active: false,
    })
  })

  it('drops empty strings and non-finite orders', () => {
    expect(
      sanitizePick({
        model_name: 'a/b',
        title: '',
        summary: '',
        icon: '',
        order: Number.NaN,
      })
    ).toEqual({ model_name: 'a/b' })
  })
})

describe('filterStaffPicksForPlatform', () => {
  const picks: StaffPick[] = [
    { model_name: 'universal/one', order: 20 },
    { model_name: 'mac/only', platforms: ['macos'], order: 10 },
    { model_name: 'win-linux/only', platforms: ['windows', 'linux'], order: 30 },
    { model_name: 'disabled/everywhere', active: false, order: 1 },
    { model_name: 'unordered/tail' },
  ]

  it('keeps universal entries on every platform', () => {
    for (const os of ['macos', 'windows', 'linux'] as const) {
      expect(
        filterStaffPicksForPlatform(picks, os).map((p) => p.model_name)
      ).toContain('universal/one')
    }
  })

  it('hides macOS-only entries on Windows and Linux', () => {
    expect(
      filterStaffPicksForPlatform(picks, 'windows').map((p) => p.model_name)
    ).not.toContain('mac/only')
    expect(
      filterStaffPicksForPlatform(picks, 'linux').map((p) => p.model_name)
    ).not.toContain('mac/only')
  })

  it('hides Windows/Linux-only entries on macOS', () => {
    expect(
      filterStaffPicksForPlatform(picks, 'macos').map((p) => p.model_name)
    ).not.toContain('win-linux/only')
  })

  it('always drops entries with active: false', () => {
    for (const os of ['macos', 'windows', 'linux'] as const) {
      expect(
        filterStaffPicksForPlatform(picks, os).map((p) => p.model_name)
      ).not.toContain('disabled/everywhere')
    }
  })

  it('sorts by order and puts unordered entries last', () => {
    expect(
      filterStaffPicksForPlatform(picks, 'macos').map((p) => p.model_name)
    ).toEqual(['mac/only', 'universal/one', 'unordered/tail'])
  })

  it('keeps manifest order for entries sharing the same order value', () => {
    const tied: StaffPick[] = [
      { model_name: 'second/one', order: 5 },
      { model_name: 'first/one', order: 5 },
    ]
    expect(
      filterStaffPicksForPlatform(tied, 'linux').map((p) => p.model_name)
    ).toEqual(['second/one', 'first/one'])
  })
})

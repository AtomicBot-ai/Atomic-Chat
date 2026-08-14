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
import { iconKeyLogoSrc } from '@/lib/model-logo'

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

describe('BASELINE_STAFF_PICKS', () => {
  it('survives the sanitizer unchanged, field for field', () => {
    for (const pick of BASELINE_STAFF_PICKS) {
      expect(sanitizePick(pick), pick.model_name).toEqual(pick)
    }
  })

  it('gives every model an MLX twin that is macOS-only', () => {
    const mlx = BASELINE_STAFF_PICKS.filter((p) => p.format === 'mlx')
    expect(mlx.length).toBeGreaterThan(0)
    for (const pick of mlx) {
      expect(pick.platforms, pick.model_name).toEqual(['macos'])
      expect(pick.description_key, pick.model_name).toBe('hub:recForMlx')
    }
  })

  it('never lists the same repo or the same order twice', () => {
    const names = BASELINE_STAFF_PICKS.map((p) => p.model_name)
    expect(new Set(names).size).toBe(names.length)
    const orders = BASELINE_STAFF_PICKS.map((p) => p.order)
    expect(new Set(orders).size).toBe(orders.length)
  })

  //* Категории Recommended — источник capability-байджей, поэтому конверсии
  //* одной модели не должны обещать разные возможности.
  it('declares the same capabilities on a GGUF pick and its MLX twin', () => {
    const CAPABILITIES = ['vision', 'audio', 'reasoning', 'tools'] as const
    const capsOf = (pick: StaffPick) =>
      CAPABILITIES.filter((cap) => pick.categories?.includes(cap))

    const byModel = new Map<string, Map<string, string[]>>()
    for (const pick of BASELINE_STAFF_PICKS) {
      const model = (pick.title ?? pick.model_name).replace(/ \(MLX\)$/, '')
      if (!byModel.has(model)) byModel.set(model, new Map())
      byModel.get(model)!.set(pick.model_name, capsOf(pick))
    }

    const pairs = [...byModel].filter(([, builds]) => builds.size > 1)
    expect(pairs.length).toBeGreaterThan(0)
    for (const [model, builds] of pairs) {
      const [reference, ...rest] = [...builds.values()]
      for (const caps of rest) expect(caps, model).toEqual(reference)
    }
  })

  it('references only icon keys that resolve to a bundled asset', () => {
    for (const pick of BASELINE_STAFF_PICKS) {
      if (!pick.icon) continue
      expect(iconKeyLogoSrc(pick.icon), pick.icon).toBeTruthy()
    }
  })

  //* Порядок групп курируется вручную и легко ломается при правке манифеста.
  describe('family grouping', () => {
    const TIERS = ['qwen', 'gemma', 'lfm']

    const tierOf = (icon?: string) => {
      const index = TIERS.indexOf(icon ?? '')
      return index === -1 ? TIERS.length : index
    }

    // Picks ordered ahead of the first family entry are a promoted head that is
    // curated per release and is not part of the family sequence.
    const FAMILY_SEQUENCE_START = 10

    // Both format lists are curated as one sequence, so each is checked in the
    // order the Hub renders it.
    const listed = (format: 'gguf' | 'mlx') =>
      filterStaffPicksForPlatform(BASELINE_STAFF_PICKS, 'macos', format).filter(
        (pick) =>
          (pick.order ?? Number.POSITIVE_INFINITY) >= FAMILY_SEQUENCE_START
      )

    it.each(['gguf', 'mlx'] as const)(
      'opens the %s list with Qwen, then Gemma, then LFM',
      (format) => {
        const tiers = listed(format).map((pick) => tierOf(pick.icon))
        expect(tiers.slice(0, 13)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2])
      }
    )

    it.each(['gguf', 'mlx'] as const)(
      'never drops a %s pick of a promoted family below an unrelated one',
      (format) => {
        const tiers = listed(format).map((pick) => tierOf(pick.icon))
        expect(tiers).toEqual([...tiers].sort((a, b) => a - b))
      }
    )

    // A model without an MLX build is allowed; one whose twin sits somewhere
    // else in the list is not, because the two lists would then disagree on
    // what "top of the recommendations" means.
    it('walks the MLX list in the same model order as the GGUF one', () => {
      const ggufTitles = listed('gguf').map((p) => p.title)
      const mlxTitles = listed('mlx').map((p) => p.title?.replace(/ \(MLX\)$/, ''))

      expect(mlxTitles.length).toBeGreaterThan(0)
      for (const title of mlxTitles) expect(ggufTitles).toContain(title)
      expect(mlxTitles).toEqual(
        ggufTitles.filter((title) => mlxTitles.includes(title))
      )
    })
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

  it('keeps a declared build format and drops an unknown one', () => {
    expect(sanitizePick({ model_name: 'a/b', format: 'mlx' })).toEqual({
      model_name: 'a/b',
      format: 'mlx',
    })
    expect(sanitizePick({ model_name: 'a/b', format: 'onnx' })).toEqual({
      model_name: 'a/b',
    })
  })

  it('keeps every capability category, audio included', () => {
    expect(
      sanitizePick({
        model_name: 'a/b',
        categories: ['general', 'vision', 'audio', 'reasoning', 'tools'],
      })!.categories
    ).toEqual(['general', 'vision', 'audio', 'reasoning', 'tools'])
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

  describe('format', () => {
    const byFormat: StaffPick[] = [
      { model_name: 'org/model-GGUF', format: 'gguf', order: 10 },
      {
        model_name: 'mlx-community/model-4bit',
        format: 'mlx',
        platforms: ['macos'],
        order: 15,
      },
      { model_name: 'legacy/no-format-field', order: 20 },
    ]

    it('returns only GGUF entries by default', () => {
      expect(
        filterStaffPicksForPlatform(byFormat, 'macos').map((p) => p.model_name)
      ).toEqual(['org/model-GGUF', 'legacy/no-format-field'])
    })

    it('returns only MLX entries when MLX is requested', () => {
      expect(
        filterStaffPicksForPlatform(byFormat, 'macos', 'mlx').map(
          (p) => p.model_name
        )
      ).toEqual(['mlx-community/model-4bit'])
    })

    it('treats a missing format as GGUF so older manifests keep working', () => {
      expect(
        filterStaffPicksForPlatform(byFormat, 'linux', 'gguf').map(
          (p) => p.model_name
        )
      ).toContain('legacy/no-format-field')
    })

    it('still hides macOS-only MLX entries on other platforms', () => {
      expect(filterStaffPicksForPlatform(byFormat, 'windows', 'mlx')).toEqual(
        []
      )
    })
  })
})

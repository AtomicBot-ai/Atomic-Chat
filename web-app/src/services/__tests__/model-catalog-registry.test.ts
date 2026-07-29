import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'

// Build-time globals must be set BEFORE the module under test loads.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  g.IS_TAURI = false
  g.IS_MACOS = true
  g.IS_WINDOWS = false
  g.IS_LINUX = false
  // Disable the gzip-preferred path so tests can mock a single fetch
  // call per assertion. The gzip path itself is exercised by the real
  // app + the cron `gzip` step.
  g.DecompressionStream = undefined
})

import type { CatalogManifest } from '@/services/model-catalog-registry'

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-store', () => {
  const memory = new Map<string, unknown>()
  const store = {
    get: vi.fn((key: string) => Promise.resolve(memory.get(key) ?? null)),
    set: vi.fn((key: string, value: unknown) => {
      if (value === null || value === undefined) memory.delete(key)
      else memory.set(key, value)
      return Promise.resolve()
    }),
    delete: vi.fn((key: string) => {
      memory.delete(key)
      return Promise.resolve()
    }),
    clear: vi.fn(() => {
      memory.clear()
      return Promise.resolve()
    }),
    save: vi.fn(() => Promise.resolve()),
    reset: vi.fn(() => {
      memory.clear()
      return Promise.resolve()
    }),
    close: vi.fn(() => Promise.resolve()),
    load: vi.fn(() => Promise.resolve()),
    onKeyChange: vi.fn(),
    onKeysChange: vi.fn(),
  }
  return {
    load: vi.fn(() => Promise.resolve(store)),
  }
})

const buildManifest = (
  overrides: Partial<CatalogManifest> = {}
): CatalogManifest => ({
  manifest_version: 1,
  schema_version: 1,
  updated_at: '2026-05-27T12:00:00Z',
  orgs: ['unsloth'],
  models: [
    {
      model_name: 'unsloth/test',
      developer: 'unsloth',
      downloads: 0,
      quants: [],
    },
  ],
  ...overrides,
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('model-catalog-registry', () => {
  it('returns remote source when fetch succeeds', async () => {
    const manifest = buildManifest()
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => manifest,
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const { getCatalogOrFallback, clearCatalogCache } = await import(
      '@/services/model-catalog-registry'
    )
    await clearCatalogCache()

    const result = await getCatalogOrFallback()
    expect(result.source).toBe('remote')
    expect(result.manifest.models).toHaveLength(1)
    expect(result.manifest.models[0].model_name).toBe('unsloth/test')
  })

  it('uses cache on a second call within TTL', async () => {
    const manifest = buildManifest()
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => manifest,
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const { getCatalogOrFallback, clearCatalogCache } = await import(
      '@/services/model-catalog-registry'
    )
    await clearCatalogCache()

    const first = await getCatalogOrFallback()
    expect(first.source).toBe('remote')

    const second = await getCatalogOrFallback()
    expect(second.source).toBe('cache')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to baseline when fetch fails and no cache exists', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'))
    vi.stubGlobal('fetch', fetchMock)

    const { getCatalogOrFallback, clearCatalogCache } = await import(
      '@/services/model-catalog-registry'
    )
    await clearCatalogCache()

    const result = await getCatalogOrFallback()
    expect(result.source).toBe('baseline')
    expect(result.manifest.models.length).toBeGreaterThan(0)
    expect(result.error).toContain('boom')
  })

  it('falls back to cache when fetch fails after a successful first call', async () => {
    const manifest = buildManifest()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => manifest,
      } as Response)
      .mockRejectedValueOnce(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    const { getCatalogOrFallback, clearCatalogCache } = await import(
      '@/services/model-catalog-registry'
    )
    await clearCatalogCache()

    await getCatalogOrFallback()
    const fallback = await getCatalogOrFallback({ force: true })
    expect(fallback.source).toBe('cache')
    expect(fallback.error).toContain('network down')
    expect(fallback.manifest.models[0].model_name).toBe('unsloth/test')
  })

  it('rejects manifests with newer schema_version', async () => {
    const manifest = buildManifest({ schema_version: 999 })
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => manifest,
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const { getCatalogOrFallback, clearCatalogCache } = await import(
      '@/services/model-catalog-registry'
    )
    await clearCatalogCache()

    const result = await getCatalogOrFallback()
    expect(result.source).toBe('baseline')
    expect(result.error).toMatch(/schema_version 999/)
  })

  it('rejects malformed payloads', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ not_a_manifest: true }),
    } as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    const { getCatalogOrFallback, clearCatalogCache } = await import(
      '@/services/model-catalog-registry'
    )
    await clearCatalogCache()

    const result = await getCatalogOrFallback()
    expect(result.source).toBe('baseline')
    expect(result.error).toMatch(/not a valid catalog/)
  })

  it('caches and retrieves a manifest larger than any localStorage quota', async () => {
    const bigManifest = buildManifest({
      models: [
        {
          ...buildManifest().models[0],
          description: 'x'.repeat(2_000_000),
        },
      ],
    })
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => bigManifest,
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const { getCatalogOrFallback, clearCatalogCache } = await import(
      '@/services/model-catalog-registry'
    )
    await clearCatalogCache()

    const first = await getCatalogOrFallback()
    expect(first.source).toBe('remote')

    const second = await getCatalogOrFallback()
    expect(second.source).toBe('cache')
    expect(second.manifest.models[0].description).toHaveLength(2_000_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not write the catalog to localStorage, even for large payloads', async () => {
    const localStorageSetItem = vi.fn()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(),
      setItem: localStorageSetItem,
      removeItem: vi.fn(),
      clear: vi.fn(),
    })

    const bigManifest = buildManifest({
      models: [
        {
          ...buildManifest().models[0],
          description: 'x'.repeat(2_000_000),
        },
      ],
    })
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => bigManifest,
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const { getCatalogOrFallback, clearCatalogCache } = await import(
      '@/services/model-catalog-registry'
    )
    await clearCatalogCache()
    await getCatalogOrFallback()

    expect(localStorageSetItem).not.toHaveBeenCalled()
  })
})

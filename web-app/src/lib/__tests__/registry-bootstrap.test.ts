/**
 * Start-up policy for the configuration registries: a default build (no
 * `VITE_*_URL` overrides) touches no network, drops any copy an earlier build
 * downloaded, and only reads the model catalog from the app's own assets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ log: [] as string[] }))

type Overrides = Partial<
  Record<
    'providers' | 'recommended' | 'staffPicks' | 'media' | 'catalog',
    string
  >
>

async function loadBootstrap(overrides: Overrides = {}) {
  vi.resetModules()
  const record = (name: string) => () => {
    calls.log.push(name)
  }
  vi.doMock('@/services/provider-registry', () => ({
    REGISTRY_URL: overrides.providers ?? null,
    clearRegistryCache: record('clear:providers'),
  }))
  vi.doMock('@/services/recommended-models-registry', () => ({
    REGISTRY_URL: overrides.recommended ?? null,
    clearRegistryCache: record('clear:recommended'),
  }))
  vi.doMock('@/services/staff-picks-registry', () => ({
    STAFF_PICKS_URL: overrides.staffPicks ?? null,
    clearStaffPicksCache: record('clear:staff-picks'),
  }))
  vi.doMock('@/services/media-registry', () => ({
    MEDIA_REGISTRY_URL: overrides.media ?? null,
    clearMediaRegistryCache: record('clear:media'),
  }))
  vi.doMock('@/services/model-catalog-registry', () => ({
    CATALOG_URL: overrides.catalog ?? null,
    CATALOG_INDEX_URL: null,
    clearCatalogCache: async () => {
      calls.log.push('clear:catalog')
    },
  }))
  const store = (name: string) => ({
    getState: () => ({
      refresh: async () => {
        calls.log.push(`refresh:${name}`)
      },
    }),
  })
  vi.doMock('@/stores/provider-registry-store', () => ({
    useProviderRegistryStore: store('providers'),
  }))
  vi.doMock('@/stores/recommended-models-registry-store', () => ({
    useRecommendedModelsRegistryStore: store('recommended'),
  }))
  vi.doMock('@/stores/staff-picks-store', () => ({
    useStaffPicksStore: store('staff-picks'),
  }))
  vi.doMock('@/stores/model-catalog-store', () => ({
    useModelCatalogStore: store('catalog'),
  }))
  return import('../registry-bootstrap')
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('bootstrapRegistries', () => {
  beforeEach(() => {
    calls.log = []
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('in a default build drops stale caches, refreshes nothing remote and fetches nothing', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { bootstrapRegistries } = await loadBootstrap()

    bootstrapRegistries()
    await settle()

    expect([...calls.log].sort()).toEqual(
      [
        'clear:catalog',
        'clear:media',
        'clear:providers',
        'clear:recommended',
        'clear:staff-picks',
        // The catalog store reads the bundled seed; it is always started.
        'refresh:catalog',
      ].sort()
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refreshes only the registries whose build sets an override', async () => {
    const { bootstrapRegistries } = await loadBootstrap({
      staffPicks: 'https://registry.example/staff-picks.json',
      media: 'https://registry.example/media.json',
    })

    bootstrapRegistries()
    await settle()

    expect(calls.log).toContain('refresh:staff-picks')
    expect(calls.log).not.toContain('clear:staff-picks')
    // Media is refreshed on request only, and its cache is kept.
    expect(calls.log).not.toContain('clear:media')
    expect(calls.log).toContain('clear:providers')
    expect(calls.log).not.toContain('refresh:providers')
  })

  it('does its work once', async () => {
    const { bootstrapRegistries, resetRegistryBootstrapForTests } =
      await loadBootstrap()

    bootstrapRegistries()
    bootstrapRegistries()
    await settle()
    expect(calls.log.filter((c) => c === 'refresh:catalog')).toHaveLength(1)

    resetRegistryBootstrapForTests()
    bootstrapRegistries()
    await settle()
    expect(calls.log.filter((c) => c === 'refresh:catalog')).toHaveLength(2)
  })
})

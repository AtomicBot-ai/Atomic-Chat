/**
 * Task 15 Step 1 - the remote media registry loader.
 *
 * A structural clone of `provider-registry.ts`, and these tests cover the same
 * seven rows of the failure-mode table in `services/AGENTS.md` §1, because the
 * promise is identical: `getMediaProvidersOrFallback()` NEVER THROWS. UI code
 * renders unconditionally and must not wrap it in try/catch for control flow.
 *
 * The sanitisation tests matter more here than in the provider registry. This
 * payload can add a PROVIDER, which means it can add a URL the app will talk
 * to. It is remote input and is treated as hostile: unknown adapters, non-http
 * URLs and descriptors missing an id or adapter are dropped, not repaired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MEDIA_REGISTRY_SCHEMA_VERSION,
  clearMediaRegistryCache,
  getMediaProvidersOrFallback,
} from '../media-registry'
import { BASELINE_MEDIA_PROVIDERS } from '@/constants/mediaProviders'

const URL = 'https://example.invalid/media/registry.json'

function manifest(
  providers: unknown[],
  schemaVersion = MEDIA_REGISTRY_SCHEMA_VERSION
) {
  return {
    schema_version: schemaVersion,
    updated_at: '2026-09-10T00:00:00Z',
    providers,
  }
}

function remoteProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hosted-images',
    label: 'Hosted Images',
    kind: 'remote_http',
    adapter: 'openai-images',
    base_url: 'https://api.example.com/v1',
    enabled: false,
    ...overrides,
  }
}

function respondWith(body: unknown, ok = true) {
  return vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Server Error',
    json: async () => body,
  })) as unknown as typeof fetch
}

beforeEach(() => {
  clearMediaRegistryCache()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-10T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the seven failure modes', () => {
  it.each(['a1111', 'replicate', 'fal-ai', 'stability-ai'])(
    'accepts the bundled %s adapter from the registry',
    async (adapter) => {
      vi.stubGlobal(
        'fetch',
        respondWith(manifest([remoteProvider({ id: adapter, adapter })]))
      )
      const result = await getMediaProvidersOrFallback({ url: URL })
      expect(result.providers).toContainEqual(
        expect.objectContaining({ id: adapter, adapter })
      )
    }
  )
  it('fetch succeeds: returns remote and caches it', async () => {
    vi.stubGlobal('fetch', respondWith(manifest([remoteProvider()])))

    const result = await getMediaProvidersOrFallback({ url: URL })

    expect(result.source).toBe('remote')
    expect(result.providers.some((p) => p.id === 'hosted-images')).toBe(true)
  })

  it('fresh cache, no force: does not touch the network', async () => {
    vi.stubGlobal('fetch', respondWith(manifest([remoteProvider()])))
    await getMediaProvidersOrFallback({ url: URL })

    const second = vi.fn()
    vi.stubGlobal('fetch', second)

    const result = await getMediaProvidersOrFallback({ url: URL })

    expect(result.source).toBe('cache')
    expect(second).not.toHaveBeenCalled()
    expect(result.providers.some((p) => p.id === 'hosted-images')).toBe(true)
  })

  it('fetch fails with a stale cache: serves the cache and names the error', async () => {
    vi.stubGlobal('fetch', respondWith(manifest([remoteProvider()])))
    await getMediaProvidersOrFallback({ url: URL })

    // Past the one-hour TTL.
    vi.setSystemTime(new Date('2026-09-10T14:00:00Z'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch
    )

    const result = await getMediaProvidersOrFallback({ url: URL })

    expect(result.source).toBe('cache')
    expect(result.error).toBeTruthy()
    expect(result.providers.some((p) => p.id === 'hosted-images')).toBe(true)
  })

  it('fetch fails with no cache: falls back to the bundled baseline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch
    )

    const result = await getMediaProvidersOrFallback({ url: URL })

    expect(result.source).toBe('baseline')
    expect(result.providers).toHaveLength(BASELINE_MEDIA_PROVIDERS.length)
  })

  it('schema_version above support: refuses the payload entirely', async () => {
    // Half-understanding a future contract is worse than ignoring it: it would
    // configure providers from fields this build does not know how to read.
    vi.stubGlobal(
      'fetch',
      respondWith(
        manifest([remoteProvider()], MEDIA_REGISTRY_SCHEMA_VERSION + 1)
      )
    )

    const result = await getMediaProvidersOrFallback({ url: URL })

    expect(result.source).toBe('baseline')
    expect(result.providers.some((p) => p.id === 'hosted-images')).toBe(false)
  })

  it('malformed payload: falls back rather than half-reading it', async () => {
    vi.stubGlobal('fetch', respondWith({ nonsense: true }))

    const result = await getMediaProvidersOrFallback({ url: URL })

    expect(result.source).toBe('baseline')
  })

  it('never throws, whatever the network does', async () => {
    // The documented contract. UI code renders unconditionally.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('DNS exploded')
      }) as unknown as typeof fetch
    )

    await expect(
      getMediaProvidersOrFallback({ url: URL })
    ).resolves.toBeTruthy()
  })
})

describe('the registry is untrusted input', () => {
  it('drops a provider naming an adapter this build does not have', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith(
        manifest([remoteProvider({ adapter: 'some-future-adapter' })])
      )
    )

    const result = await getMediaProvidersOrFallback({ url: URL })

    expect(result.providers.some((p) => p.id === 'hosted-images')).toBe(false)
  })

  it('drops a non-http(s) base_url', async () => {
    // file:// or a custom scheme would point the app at something local.
    vi.stubGlobal(
      'fetch',
      respondWith(
        manifest([remoteProvider({ base_url: 'file:///etc/passwd' })])
      )
    )

    const result = await getMediaProvidersOrFallback({ url: URL })

    expect(result.providers.some((p) => p.id === 'hosted-images')).toBe(false)
  })

  it('drops a descriptor with no id or no adapter', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith(
        manifest([
          { label: 'No id', kind: 'remote_http', adapter: 'openai-images' },
          { id: 'no-adapter', label: 'No adapter', kind: 'remote_http' },
        ])
      )
    )

    const result = await getMediaProvidersOrFallback({ url: URL })

    expect(result.providers.some((p) => p.id === 'no-adapter')).toBe(false)
    expect(result.providers).toHaveLength(BASELINE_MEDIA_PROVIDERS.length)
  })

  it('never lets the registry carry a credential', async () => {
    // A registry entry that could name a secret would be a remote party
    // choosing where the app looks for a credential.
    vi.stubGlobal(
      'fetch',
      respondWith(
        manifest([
          remoteProvider({
            auth: {
              type: 'api_key',
              setting_key: 'media.someone-elses.api_key',
            },
          }),
        ])
      )
    )

    const result = await getMediaProvidersOrFallback({ url: URL })
    const hosted = result.providers.find((p) => p.id === 'hosted-images')

    expect(hosted?.auth?.setting_key).toBe('media.hosted-images.api_key')
  })

  it('marks every remote entry as origin registry, never builtin', async () => {
    // `origin` decides what the store lets a user remove and what a later
    // release may overwrite. A payload claiming `builtin` would make itself
    // undeletable.
    vi.stubGlobal(
      'fetch',
      respondWith(manifest([remoteProvider({ origin: 'builtin' })]))
    )

    const result = await getMediaProvidersOrFallback({ url: URL })
    const hosted = result.providers.find((p) => p.id === 'hosted-images')

    expect(hosted?.origin).toBe('registry')
  })

  it('never lets a remote entry displace the bundled baseline', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith(
        manifest([
          remoteProvider({
            id: BASELINE_MEDIA_PROVIDERS[0]!.id,
            base_url: 'https://somewhere-else.example',
          }),
        ])
      )
    )

    const result = await getMediaProvidersOrFallback({ url: URL })
    const matching = result.providers.filter(
      (p) => p.id === BASELINE_MEDIA_PROVIDERS[0]!.id
    )

    // Exactly one, not "the first one is right". A duplicate id would make the
    // selection state ambiguous and every model id it qualifies ambiguous too -
    // and `find()` would happily hide that by returning the bundled entry.
    expect(matching).toHaveLength(1)
    expect(matching[0]!.base_url).toBe(BASELINE_MEDIA_PROVIDERS[0]!.base_url)
    expect(matching[0]!.origin).toBe('builtin')
  })
})

import { beforeEach, expect, it, vi } from 'vitest'
import {
  atomicModelCatalogBaseline,
  atomicModelCatalogSnapshot,
  atomicModelCatalogStatus,
  clearAtomicModelCatalogCache,
  loadAtomicModelCatalog,
} from './modelCatalog'
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  })
  clearAtomicModelCatalogCache()
})
it('isolates override catalogs from production in memory and persisted storage', async () => {
  const dev = { ...atomicModelCatalogBaseline(), updated_at: '2026-11-01T00:00:00Z' }
  const production = { ...atomicModelCatalogBaseline(), updated_at: '2026-11-02T00:00:00Z' }
  const remote = vi.fn(async () => new Response(JSON.stringify(production)))
  const url = 'file:///tmp/dev-catalog.json'
  await loadAtomicModelCatalog({ url, fetch: async () => new Response(JSON.stringify(dev)) })
  expect(await loadAtomicModelCatalog({ fetch: remote })).toEqual(production)
  expect(remote).toHaveBeenCalledTimes(1)
  expect(atomicModelCatalogSnapshot({ url })).toEqual(dev)
  expect(atomicModelCatalogSnapshot()).toEqual(production)
  expect(atomicModelCatalogStatus({ url }).source).toBe('remote')
  vi.resetModules()
  const reloaded = await import('./modelCatalog')
  expect(reloaded.atomicModelCatalogSnapshot()).toEqual(production)
  expect(reloaded.atomicModelCatalogSnapshot({ url })).toEqual(dev)
})

it('keeps planners on the configured source without reusing it for explicit production requests', async () => {
  const { configureAtomicModelCatalogSource } = await import('./modelCatalog')
  const { ATOMIC_MODEL_CATALOG_URL } = await import('./catalogProtocol')
  const dev = { ...atomicModelCatalogBaseline(), updated_at: '2026-10-01T00:00:00Z' }
  const production = atomicModelCatalogBaseline()
  try {
    configureAtomicModelCatalogSource('file:///tmp/selected-catalog.json')
    await loadAtomicModelCatalog({ fetch: async () => Response.json(dev) })
    expect(atomicModelCatalogSnapshot()).toEqual(dev)
    await loadAtomicModelCatalog({
      url: ATOMIC_MODEL_CATALOG_URL,
      fetch: async () => Response.json(production),
    })
    expect(atomicModelCatalogSnapshot()).toEqual(dev)
    configureAtomicModelCatalogSource()
    expect(atomicModelCatalogSnapshot()).toEqual(production)
  } finally {
    configureAtomicModelCatalogSource()
  }
})

it('rejects an old cache whose production key may contain a developer override', async () => {
  const unbound = { ...atomicModelCatalogBaseline(), updated_at: '2026-10-02T00:00:00Z' }
  localStorage.setItem(
    'atomic_unified_model_catalog_v1',
    JSON.stringify({ at: Date.now(), catalog: unbound })
  )
  const production = atomicModelCatalogBaseline()
  const request = vi.fn(async () => Response.json(production))
  expect(await loadAtomicModelCatalog({ fetch: request })).toEqual(production)
  expect(request).toHaveBeenCalledTimes(1)
})

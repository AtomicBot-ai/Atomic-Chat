import { afterEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  atomicModelCatalogBaseline,
  clearAtomicModelCatalogCache,
} from '@janhq/core'
import fixture from './fixtures/catalog.json'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  clearAtomicModelCatalogCache()
})

it('reads Strata from the local catalog file without a production request', async () => {
  vi.resetModules()
  vi.stubEnv(
    'ATOMIC_MODEL_CATALOG_URL',
    'file:///tmp/atomic-strata-fixture/catalog.json'
  )
  const baseline = atomicModelCatalogBaseline()
  vi.mocked(invoke).mockResolvedValue(
    JSON.stringify({
      ...baseline,
      models: { ...baseline.models, ...fixture.models },
      collections: { ...baseline.collections, ...fixture.collections },
    })
  )
  const network = vi.fn(() => {
    throw new Error('Unexpected catalog network request')
  })
  vi.stubGlobal('fetch', network)

  const { fetchStrataCatalog } = await import('../catalog')
  expect((await fetchStrataCatalog()).map((row) => row.model_name)).toEqual([
    'strata/ud-q4-k-xl-mtp',
  ])
  expect(invoke).toHaveBeenCalledWith('read_file_sync', {
    args: ['/tmp/atomic-strata-fixture/catalog.json'],
  })
  expect(network).not.toHaveBeenCalled()
})

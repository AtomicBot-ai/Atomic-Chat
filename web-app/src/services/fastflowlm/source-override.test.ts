import { afterEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  atomicModelCatalogBaseline,
  clearAtomicModelCatalogCache,
} from '@janhq/core'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  clearAtomicModelCatalogCache()
})
it('reads the complete local conf catalog without contacting production', async () => {
  vi.stubEnv(
    'VITE_ATOMIC_MODEL_CATALOG_URL',
    'file:///tmp/atomic-fixture/catalog.json'
  )
  vi.resetModules()
  clearAtomicModelCatalogCache()
  vi.mocked(invoke).mockResolvedValue(
    JSON.stringify(atomicModelCatalogBaseline())
  )
  const network = vi.fn(() => {
    throw new Error('Unexpected production request')
  })
  vi.stubGlobal('fetch', network)
  const { fetchFastFlowLmModels } = await import('./catalog')
  expect(await fetchFastFlowLmModels(true)).toHaveLength(44)
  expect(invoke).toHaveBeenCalledWith('read_file_sync', {
    args: ['/tmp/atomic-fixture/catalog.json'],
  })
  expect(network).not.toHaveBeenCalled()
})

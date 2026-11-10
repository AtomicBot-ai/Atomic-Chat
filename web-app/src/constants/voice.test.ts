import { afterEach, expect, it, vi } from 'vitest'
import {
  ATOMIC_MODEL_CATALOG_URL,
  atomicModelCatalogBaseline,
  clearAtomicModelCatalogCache,
} from '@janhq/core'

afterEach(() => {
  clearAtomicModelCatalogCache()
  localStorage.clear()
})

it('keeps startup and installed-model size metadata available when a catalog omits voice', async () => {
  const catalog = structuredClone(atomicModelCatalogBaseline())
  for (const [id, entry] of Object.entries(catalog.models))
    if (entry.kind === 'auxiliary' && entry.definition.role === 'voice')
      delete catalog.models[id]
  // A cache entry names its source; an unbound one is refused as a possible override.
  localStorage.setItem(
    'atomic_unified_model_catalog_v1',
    JSON.stringify({ url: ATOMIC_MODEL_CATALOG_URL, catalog, at: Date.now() })
  )
  vi.resetModules()
  const voice = await import('./voice')
  expect(voice.VOICE_MODEL_BYTES).toBeGreaterThan(0)
  expect(voice.voiceModelDownloadBytes()).toBe(voice.VOICE_MODEL_BYTES)
  expect(() => voice.voiceModelSources()).toThrow(
    'No valid auxiliary model source'
  )
})

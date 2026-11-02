import { afterEach, expect, it, vi } from 'vitest'
import {
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
  localStorage.setItem(
    'atomic_unified_model_catalog_v1',
    JSON.stringify({ catalog, at: Date.now() })
  )
  vi.resetModules()
  const voice = await import('./voice')
  expect(voice.VOICE_MODEL_BYTES).toBeGreaterThan(0)
  expect(voice.voiceModelDownloadBytes()).toBe(voice.VOICE_MODEL_BYTES)
  expect(() => voice.voiceModelSources()).toThrow(
    'No valid auxiliary model source'
  )
})

/**
 * Bring a model another app left on disk into the library, without copying.
 *
 * Shared by Settings → "Detected model locations" and the composer's
 * "what do I reply with?" widget, so a folder added from either lands the
 * same way: the engine's `import()` writes a `model.yml` that points at the
 * existing file, and the provider list is refreshed so the model shows up
 * with its source badge.
 */

import { EngineManager } from '@janhq/core'

import { useModelProvider } from '@/hooks/useModelProvider'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'
import type { ServiceHub } from '@/services'
import type { LocalModelCandidate } from '@/services/models/localScan'

/** Which engine a scanned candidate loads in. */
export function providerForScannedModel(
  cand: LocalModelCandidate
): 'mlx' | typeof LOCAL_LLAMACPP_PROVIDER {
  return cand.format === 'mlx' ? 'mlx' : LOCAL_LLAMACPP_PROVIDER
}

/**
 * Import `cand` and refresh the provider store. Resolves to the provider it
 * now lives under; rejects with the engine's error, or when the engine is
 * not registered at all.
 */
export async function importScannedModel(
  cand: LocalModelCandidate,
  serviceHub: ServiceHub
): Promise<{ providerName: string; modelId: string }> {
  const providerName = providerForScannedModel(cand)
  const engine = EngineManager.instance().get(providerName)
  if (!engine) {
    throw new Error(`Engine ${providerName} not available`)
  }
  await engine.import(cand.id, {
    modelPath: cand.path,
    mmprojPath: cand.mmprojPath,
    source: cand.source,
  })
  const providers = await serviceHub.providers().getProviders()
  useModelProvider.getState().setProviders(providers)
  return { providerName, modelId: cand.id }
}

/**
 * The candidate to start when a folder holds several: the smallest runnable
 * one loads fastest. Unsized candidates sort last, so a measured model always
 * wins over an unmeasured one. `null` when nothing in the list can run.
 */
export function pickSmallestRunnable(
  cands: readonly LocalModelCandidate[]
): LocalModelCandidate | null {
  let best: LocalModelCandidate | null = null
  for (const cand of cands) {
    if (!cand.runnable) continue
    if (!best) {
      best = cand
      continue
    }
    const size = cand.sizeBytes ?? Number.POSITIVE_INFINITY
    const bestSize = best.sizeBytes ?? Number.POSITIVE_INFINITY
    if (size < bestSize) best = cand
  }
  return best
}

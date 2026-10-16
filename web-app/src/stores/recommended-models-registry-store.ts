/**
 * Zustand store wrapping the remote recommended-models registry loader.
 *
 * Mirrors `provider-registry-store.ts`:
 *  - Holds the manifest in memory for synchronous access from React
 *    components and non-React modules.
 *  - Exposes loading status / last-fetch metadata for UI.
 *
 * The store starts out holding the bundled snapshot, already initialized.
 * Importing it performs no I/O; only a build with a registry override has
 * anything to refresh, and `lib/registry-bootstrap.ts` starts that once.
 *
 * The store keeps the platform-neutral list. Use the
 * {@link useRecommendedModelsForPlatform} selector (or
 * {@link getRecommendationsSync}) to obtain the list filtered for the
 * current host OS.
 */

import { create } from 'zustand'
import {
  REGISTRY_URL,
  bundledResult,
  filterRecommendationsForPlatform,
  getCachedManifest,
  getRecommendationsOrFallback,
  type FetchOptions,
  type Recommendation,
  type RecommendationPlatform,
  type RegistryFetchResult,
  type RegistrySource,
} from '@/services/recommended-models-registry'
import type { HardwareTier } from '@/lib/hardware-tier'

export type RegistryStatus = 'idle' | 'loading' | 'success' | 'error'

type RegistryState = {
  recommendations: Recommendation[]
  /** Per-tier overrides from the manifest. Partial by design — a tier the
   *  manifest omits falls back to the bundled ladder in
   *  `selectTierRecommendations`. */
  tiers: Partial<Record<HardwareTier, Recommendation[]>>
  status: RegistryStatus
  source: RegistrySource
  fetchedAt: number | null
  manifestUpdatedAt: string | null
  error: string | null
  /** True until the first refresh resolves (success or fallback). */
  hasInitialized: boolean
  refresh: (options?: FetchOptions) => Promise<void>
}

/**
 * First paint: a cached remote copy when this build has a registry override
 * and one is on disk, otherwise the bundled snapshot. Without an override the
 * bundled snapshot is the final answer, so the store starts initialized.
 */
const seedState = (): Pick<
  RegistryState,
  | 'recommendations'
  | 'tiers'
  | 'source'
  | 'fetchedAt'
  | 'manifestUpdatedAt'
  | 'hasInitialized'
> => {
  const cached = REGISTRY_URL ? getCachedManifest() : null
  if (cached) {
    return {
      recommendations: cached.manifest.recommendations.slice(),
      // A cache entry written before the manifest gained its tier lists has
      // none; `selectTierRecommendations` falls back to the bundled ladder.
      tiers: { ...(cached.manifest.tiers ?? {}) },
      source: 'cache',
      fetchedAt: cached.fetchedAt,
      manifestUpdatedAt: cached.manifest.updated_at,
      hasInitialized: false,
    }
  }
  const bundled = bundledResult()
  return {
    recommendations: bundled.recommendations,
    tiers: bundled.tiers,
    source: bundled.source,
    fetchedAt: null,
    manifestUpdatedAt: bundled.manifestUpdatedAt,
    hasInitialized: REGISTRY_URL === null,
  }
}

export const useRecommendedModelsRegistryStore = create<RegistryState>()(
  (set) => ({
    ...seedState(),
    status: 'idle',
    error: null,
    refresh: async (options?: FetchOptions) => {
      set({ status: 'loading', error: null })

      let result: RegistryFetchResult
      try {
        result = await getRecommendationsOrFallback(options)
      } catch (error) {
        // `getRecommendationsOrFallback` already catches network errors and
        // returns a fallback result — this branch is purely defensive
        // against unexpected synchronous bugs in the loader.
        const message =
          error instanceof Error
            ? error.message
            : 'Unknown recommended-models registry error'
        console.warn(
          '[recommended-models-registry-store] refresh threw:',
          message
        )
        result = bundledResult(message)
      }

      set({
        recommendations: result.recommendations,
        tiers: result.tiers,
        source: result.source,
        fetchedAt: result.fetchedAt,
        manifestUpdatedAt: result.manifestUpdatedAt,
        status: result.error ? 'error' : 'success',
        error: result.error ?? null,
        hasInitialized: true,
      })
    },
  })
)

const detectCurrentOs = (): RecommendationPlatform => {
  if (typeof IS_MACOS !== 'undefined' && IS_MACOS) return 'macos'
  if (typeof IS_WINDOWS !== 'undefined' && IS_WINDOWS) return 'windows'
  return 'linux'
}

/**
 * Synchronous accessor for non-React code, returning the full (unfiltered)
 * list currently in the store.
 */
export const getRecommendationsSync = (): Recommendation[] =>
  useRecommendedModelsRegistryStore.getState().recommendations

/**
 * Synchronous accessor returning recommendations filtered for the current
 * host OS.
 */
export const getRecommendationsForCurrentPlatformSync = (): Recommendation[] =>
  filterRecommendationsForPlatform(
    useRecommendedModelsRegistryStore.getState().recommendations,
    detectCurrentOs()
  )

/**
 * Ensure the registry has resolved at least once. Cheap on subsequent calls —
 * returns immediately when initialization is already complete.
 */
export const ensureRecommendedModelsLoaded = async (): Promise<
  Recommendation[]
> => {
  const state = useRecommendedModelsRegistryStore.getState()
  if (state.hasInitialized) return state.recommendations
  await state.refresh()
  return useRecommendedModelsRegistryStore.getState().recommendations
}

/**
 * Zustand store wrapping the remote provider registry loader.
 *
 * Responsibilities:
 *  - Hold the merged list of providers (remote + baseline) for synchronous
 *    access from both React components and non-React modules.
 *  - Expose loading status / last-fetch metadata for UI.
 *
 * The store starts out holding the bundled snapshot, already initialized.
 * Importing it performs no I/O; only a build with a registry override has
 * anything to refresh, and `lib/registry-bootstrap.ts` starts that once.
 *
 * Design notes:
 *  The refresh action is intentionally simple — every call awaits
 *  `getProvidersOrFallback` (which already handles network timeouts and
 *  fallback) and then writes a deterministic terminal state into the store.
 *  This avoids the "stuck spinner" class of bugs that arise when refresh
 *  promises depend on shared singletons or nested timeout races.
 *
 * See `web-app/src/services/AGENTS.md` for feature-level guidance.
 */

import { create } from 'zustand'
import {
  REGISTRY_URL,
  bundledResult,
  getCachedManifest,
  getProvidersOrFallback,
  mergeWithBaseline,
  type FetchOptions,
  type RegistryFetchResult,
  type RegistrySource,
} from '@/services/provider-registry'

export type RegistryStatus = 'idle' | 'loading' | 'success' | 'error'
export type { RegistrySource }

type RegistryState = {
  providers: ModelProvider[]
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
  'providers' | 'source' | 'fetchedAt' | 'manifestUpdatedAt' | 'hasInitialized'
> => {
  const cached = REGISTRY_URL ? getCachedManifest() : null
  if (cached) {
    return {
      providers: mergeWithBaseline(cached.manifest.providers),
      source: 'cache',
      fetchedAt: cached.fetchedAt,
      manifestUpdatedAt: cached.manifest.updated_at,
      hasInitialized: false,
    }
  }
  const bundled = bundledResult()
  return {
    providers: bundled.providers,
    source: bundled.source,
    fetchedAt: null,
    manifestUpdatedAt: bundled.manifestUpdatedAt,
    hasInitialized: REGISTRY_URL === null,
  }
}

export const useProviderRegistryStore = create<RegistryState>()((set) => ({
  ...seedState(),
  status: 'idle',
  error: null,
  refresh: async (options?: FetchOptions) => {
    set({ status: 'loading', error: null })

    let result: RegistryFetchResult
    try {
      result = await getProvidersOrFallback(options)
    } catch (error) {
      // `getProvidersOrFallback` already catches network errors and returns a
      // fallback result — so this branch is purely defensive against
      // unexpected synchronous bugs in the loader.
      const message =
        error instanceof Error ? error.message : 'Unknown registry error'
      console.warn('[provider-registry-store] refresh threw:', message)
      result = bundledResult(message)
    }

    set({
      providers: result.providers,
      source: result.source,
      fetchedAt: result.fetchedAt,
      manifestUpdatedAt: result.manifestUpdatedAt,
      status: result.error ? 'error' : 'success',
      error: result.error ?? null,
      hasInitialized: true,
    })
  },
}))

/**
 * Synchronous accessor for non-React code (e.g. the Tauri providers service).
 * Returns whatever providers list is currently in the store, including
 * baseline-only state during the very first load.
 */
export const getRegistryProvidersSync = (): ModelProvider[] =>
  useProviderRegistryStore.getState().providers

/**
 * Check whether a provider name is part of the system catalog (remote registry
 * or baseline). Used everywhere we need to distinguish system-defined
 * providers from user-added custom ones.
 */
export const isKnownProvider = (providerName: string): boolean => {
  if (!providerName) return false
  return useProviderRegistryStore
    .getState()
    .providers.some((p) => p.provider === providerName)
}

/**
 * Ensure the registry has resolved at least once. Cheap on subsequent calls —
 * returns immediately when initialization is already complete.
 */
export const ensureRegistryLoaded = async (): Promise<ModelProvider[]> => {
  const state = useProviderRegistryStore.getState()
  if (state.hasInitialized) return state.providers
  await state.refresh()
  return useProviderRegistryStore.getState().providers
}

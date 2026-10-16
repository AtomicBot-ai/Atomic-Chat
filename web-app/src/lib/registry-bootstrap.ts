/**
 * One-time start-up for the configuration registries (providers,
 * recommended models, staff picks, media providers, model catalog).
 *
 * Every registry ships inside the app. A default build therefore has nothing
 * to download: this only
 *
 *  - starts loading the model catalog from the app's own bundled assets, and
 *  - refreshes a registry whose build set a `VITE_*_URL` override, and
 *  - deletes the cached copy of a registry that has no override. Earlier
 *    builds downloaded every registry from a third-party repository and kept
 *    it for offline use; leaving that copy around would let it resurface the
 *    moment an override is configured later.
 *
 * Called once from `main.tsx`. Store modules perform no I/O on import, so
 * tests and non-UI code can import them freely.
 *
 * See `docs/decisions/2026-10-16-only-runtimes-sync-from-upstream.md`.
 */

import {
  REGISTRY_URL as PROVIDER_REGISTRY_URL,
  clearRegistryCache as clearProviderRegistryCache,
} from '@/services/provider-registry'
import {
  REGISTRY_URL as RECOMMENDED_MODELS_URL,
  clearRegistryCache as clearRecommendedModelsCache,
} from '@/services/recommended-models-registry'
import {
  STAFF_PICKS_URL,
  clearStaffPicksCache,
} from '@/services/staff-picks-registry'
import {
  MEDIA_REGISTRY_URL,
  clearMediaRegistryCache,
} from '@/services/media-registry'
import {
  CATALOG_INDEX_URL,
  CATALOG_URL,
  clearCatalogCache,
} from '@/services/model-catalog-registry'
import { useProviderRegistryStore } from '@/stores/provider-registry-store'
import { useRecommendedModelsRegistryStore } from '@/stores/recommended-models-registry-store'
import { useStaffPicksStore } from '@/stores/staff-picks-store'
import { useModelCatalogStore } from '@/stores/model-catalog-store'

type Registry = {
  name: string
  url: string | null
  clearCache: () => void | Promise<void>
  refresh?: () => Promise<unknown>
}

const REGISTRIES: ReadonlyArray<Registry> = [
  {
    name: 'providers',
    url: PROVIDER_REGISTRY_URL,
    clearCache: clearProviderRegistryCache,
    refresh: () => useProviderRegistryStore.getState().refresh(),
  },
  {
    name: 'recommended-models',
    url: RECOMMENDED_MODELS_URL,
    clearCache: clearRecommendedModelsCache,
    refresh: () => useRecommendedModelsRegistryStore.getState().refresh(),
  },
  {
    name: 'staff-picks',
    url: STAFF_PICKS_URL,
    clearCache: clearStaffPicksCache,
    refresh: () => useStaffPicksStore.getState().refresh(),
  },
  // Media providers are only ever refreshed on request (Settings → Media),
  // so there is nothing to start here, only a stale cache to drop.
  {
    name: 'media',
    url: MEDIA_REGISTRY_URL,
    clearCache: clearMediaRegistryCache,
  },
  {
    name: 'model-catalog',
    url: CATALOG_URL ?? CATALOG_INDEX_URL,
    clearCache: clearCatalogCache,
  },
]

let started = false

/** Idempotent; the first call does the work. */
export function bootstrapRegistries(): void {
  if (started) return
  started = true

  for (const registry of REGISTRIES) {
    const run = async () => {
      if (registry.url === null) {
        await registry.clearCache()
      } else if (registry.refresh) {
        await registry.refresh()
      }
    }
    run().catch((error: unknown) => {
      console.warn(
        `[registry-bootstrap] ${registry.name}:`,
        error instanceof Error ? error.message : error
      )
    })
  }

  // Bundled asset read in a default build; the network refresh with an
  // override. Either way the Hub should not wait for its first open.
  void useModelCatalogStore
    .getState()
    .refresh()
    .catch((error: unknown) => {
      console.warn('[registry-bootstrap] model-catalog:', error)
    })
}

/** Test seam: allow `bootstrapRegistries` to run again. */
export function resetRegistryBootstrapForTests(): void {
  started = false
}

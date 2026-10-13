/**
 * The core's remote media catalog and the providers' live model listings, in memory.
 *
 * The catalog comes from the core (`GET /media/catalog`), never from conf directly: the core is what
 * runs these models, so the app offers exactly what the core can serve. `available: false` is a core
 * without remote media (an older build): the app then offers no remote model at all. Listings are
 * asked per provider and kind when the Cloud page's media card or a picker needs them.
 */

import { create } from 'zustand'

import { getServiceHub } from '@/hooks/useServiceHub'
import type {
  MediaCatalogView,
  MediaKind,
  MediaModelDescriptor,
} from '@/services/media/types'

export type MediaListing = {
  status: 'loading' | 'ready' | 'error'
  models: MediaModelDescriptor[]
  /** Whether the provider answered live; false when only the catalog's models are known. */
  live: boolean
  error: string | null
}

type MediaCatalogState = {
  catalog: MediaCatalogView | null
  /** False once the core said it has no remote media; true until then. */
  available: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** Keyed `<provider>:<kind>`. */
  listings: Record<string, MediaListing>
  load: (options?: { force?: boolean }) => Promise<MediaCatalogView | null>
  listModels: (provider: string, kind: MediaKind) => Promise<MediaListing>
}

export const listingKey = (provider: string, kind: MediaKind) => `${provider}:${kind}`

export const useMediaCatalog = create<MediaCatalogState>()((set, get) => ({
  catalog: null,
  available: true,
  status: 'idle',
  error: null,
  listings: {},

  load: async (options = {}) => {
    const state = get()
    if (!options.force && (state.status === 'ready' || state.status === 'loading')) return state.catalog
    set({ status: 'loading', error: null })
    try {
      const media = getServiceHub().media()
      if (!media.isSupported()) {
        set({ available: false, status: 'ready', catalog: null })
        return null
      }
      const catalog = await media.catalog()
      set({ catalog, available: catalog !== null, status: 'ready' })
      return catalog
    } catch (error) {
      const message = (error as { message?: string })?.message ?? String(error)
      set({ status: 'error', error: message })
      return null
    }
  },

  listModels: async (provider, kind) => {
    const key = listingKey(provider, kind)
    const previous = get().listings[key]
    set((s) => ({
      listings: {
        ...s.listings,
        [key]: { status: 'loading', models: previous?.models ?? [], live: false, error: null },
      },
    }))
    try {
      const answer = await getServiceHub().media().providerModels(provider, kind)
      const listing: MediaListing = {
        status: answer.error ? 'error' : 'ready',
        models: answer.models,
        live: answer.live,
        error: answer.error?.message ?? null,
      }
      set((s) => ({ listings: { ...s.listings, [key]: listing } }))
      return listing
    } catch (error) {
      const listing: MediaListing = {
        status: 'error',
        models: previous?.models ?? [],
        live: false,
        error: (error as { message?: string })?.message ?? String(error),
      }
      set((s) => ({ listings: { ...s.listings, [key]: listing } }))
      return listing
    }
  },
}))

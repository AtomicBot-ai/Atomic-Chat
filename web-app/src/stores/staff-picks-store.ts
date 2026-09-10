/**
 * Zustand store wrapping the remote staff-picks registry loader.
 *
 * Mirrors `recommended-models-registry-store.ts`:
 *  - Holds the manifest in memory for synchronous access from React
 *    components and non-React modules.
 *  - Exposes loading status / last-fetch metadata for UI.
 *  - Bootstraps once when first imported.
 *
 * The store keeps the platform-neutral list. Use
 * {@link getStaffPicksForCurrentPlatformSync} (or the
 * `filterStaffPicksForPlatform` helper) to obtain the list filtered and
 * ordered for the current host OS.
 */

import { create } from 'zustand'
import {
  filterStaffPicksForPlatform,
  getCachedManifest,
  getStaffPicksOrFallback,
  type FetchOptions,
  type StaffPick,
  type StaffPickPlatform,
  type StaffPicksFetchResult,
  type StaffPicksSource,
} from '@/services/staff-picks-registry'
import { BASELINE_STAFF_PICKS } from '@/constants/staff-picks'

export type StaffPicksStatus = 'idle' | 'loading' | 'success' | 'error'

type StaffPicksState = {
  picks: StaffPick[]
  status: StaffPicksStatus
  source: StaffPicksSource
  fetchedAt: number | null
  manifestUpdatedAt: string | null
  error: string | null
  /** True until the first refresh resolves (success or fallback). */
  hasInitialized: boolean
  refresh: (options?: FetchOptions) => Promise<void>
}

const seedPicks = (): StaffPick[] => {
  const cached = getCachedManifest()
  if (cached) return cached.manifest.picks.slice()
  return BASELINE_STAFF_PICKS.slice()
}

const baselineFallback = (message: string): StaffPicksFetchResult => ({
  picks: BASELINE_STAFF_PICKS.slice(),
  source: 'baseline',
  fetchedAt: null,
  manifestUpdatedAt: null,
  error: message,
})

export const useStaffPicksStore = create<StaffPicksState>()((set) => ({
  picks: seedPicks(),
  status: 'idle',
  source: getCachedManifest() ? 'cache' : 'baseline',
  fetchedAt: getCachedManifest()?.fetchedAt ?? null,
  manifestUpdatedAt: getCachedManifest()?.manifest.updated_at ?? null,
  error: null,
  hasInitialized: false,
  refresh: async (options?: FetchOptions) => {
    set({ status: 'loading', error: null })

    let result: StaffPicksFetchResult
    try {
      result = await getStaffPicksOrFallback(options)
    } catch (error) {
      // `getStaffPicksOrFallback` already catches network errors and returns a
      // fallback result — this branch is purely defensive against unexpected
      // synchronous bugs in the loader.
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown staff-picks registry error'
      console.warn('[staff-picks-store] refresh threw:', message)
      result = baselineFallback(message)
    }

    set({
      picks: result.picks,
      source: result.source,
      fetchedAt: result.fetchedAt,
      manifestUpdatedAt: result.manifestUpdatedAt,
      status: result.error ? 'error' : 'success',
      error: result.error ?? null,
      hasInitialized: true,
    })
  },
}))

const detectCurrentOs = (): StaffPickPlatform => {
  if (typeof IS_MACOS !== 'undefined' && IS_MACOS) return 'macos'
  if (typeof IS_WINDOWS !== 'undefined' && IS_WINDOWS) return 'windows'
  return 'linux'
}

/**
 * Synchronous accessor for non-React code, returning the full (unfiltered)
 * list currently in the store.
 */
export const getStaffPicksSync = (): StaffPick[] =>
  useStaffPicksStore.getState().picks

/** Synchronous accessor returning picks filtered for the current host OS. */
export const getStaffPicksForCurrentPlatformSync = (): StaffPick[] =>
  filterStaffPicksForPlatform(
    useStaffPicksStore.getState().picks,
    detectCurrentOs()
  )

/**
 * Ensure the registry has resolved at least once. Cheap on subsequent calls —
 * returns immediately when initialization is already complete.
 */
export const ensureStaffPicksLoaded = async (): Promise<StaffPick[]> => {
  const state = useStaffPicksStore.getState()
  if (state.hasInitialized) return state.picks
  await state.refresh()
  return useStaffPicksStore.getState().picks
}

/**
 * Kick off the initial fetch in the background. Importing this module is
 * enough to start loading; tests can override or skip via mocking.
 */
if (typeof window !== 'undefined') {
  void useStaffPicksStore
    .getState()
    .refresh()
    .catch((error) => {
      console.warn('[staff-picks-store] initial refresh failed:', error)
    })
}

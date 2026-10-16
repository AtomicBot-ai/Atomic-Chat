/**
 * Zustand store wrapping the remote staff-picks registry loader.
 *
 * Mirrors `recommended-models-registry-store.ts`:
 *  - Holds the manifest in memory for synchronous access from React
 *    components and non-React modules.
 *  - Exposes loading status / last-fetch metadata for UI.
 *
 * The store starts out holding the bundled snapshot, already initialized.
 * Importing it performs no I/O; only a build with a registry override has
 * anything to refresh, and `lib/registry-bootstrap.ts` starts that once.
 *
 * The store keeps the platform-neutral list. Use
 * {@link getStaffPicksForCurrentPlatformSync} (or the
 * `filterStaffPicksForPlatform` helper) to obtain the list filtered and
 * ordered for the current host OS.
 */

import { create } from 'zustand'
import {
  STAFF_PICKS_URL,
  bundledResult,
  filterStaffPicksForPlatform,
  getCachedManifest,
  getStaffPicksOrFallback,
  type FetchOptions,
  type StaffPick,
  type StaffPickPlatform,
  type StaffPicksFetchResult,
  type StaffPicksSource,
} from '@/services/staff-picks-registry'

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

/**
 * First paint: a cached remote copy when this build has a registry override
 * and one is on disk, otherwise the bundled snapshot. Without an override the
 * bundled snapshot is the final answer, so the store starts initialized.
 */
const seedState = (): Pick<
  StaffPicksState,
  'picks' | 'source' | 'fetchedAt' | 'manifestUpdatedAt' | 'hasInitialized'
> => {
  const cached = STAFF_PICKS_URL ? getCachedManifest() : null
  if (cached) {
    return {
      picks: cached.manifest.picks.slice(),
      source: 'cache',
      fetchedAt: cached.fetchedAt,
      manifestUpdatedAt: cached.manifest.updated_at,
      hasInitialized: false,
    }
  }
  const bundled = bundledResult()
  return {
    picks: bundled.picks,
    source: bundled.source,
    fetchedAt: null,
    manifestUpdatedAt: bundled.manifestUpdatedAt,
    hasInitialized: STAFF_PICKS_URL === null,
  }
}

export const useStaffPicksStore = create<StaffPicksState>()((set) => ({
  ...seedState(),
  status: 'idle',
  error: null,
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
      result = bundledResult(message)
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

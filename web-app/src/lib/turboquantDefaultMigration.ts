/**
 * Decides, once per profile, whether the TurboQuant `llamacpp` provider is
 * active by default. Runs in `main.tsx` *before* React mounts, because the
 * fresh-install check relies on the zustand `model-provider` blob not having
 * been written yet — later in startup `main.tsx` itself may write it (the
 * `preloadModelOnStartup` reset).
 *
 * Policy: fresh installs get TurboQuant disabled (`active: false` on first
 * provider registration in `useModelProvider.setProviders`), re-enableable
 * via the Settings → Model Providers toggle. Existing profiles — anything
 * with a persisted `model-provider` blob or a completed onboarding — keep
 * today's behavior (active), including Windows profiles whose `llamacpp`
 * entry was dropped from the blob by zustand migration v13: the blob itself
 * still exists, so they classify as existing.
 *
 * The verdict is frozen into a localStorage flag so the classification never
 * flips on later launches (by the second launch every install has a blob).
 */

import { localStorageKey } from '@/constants/localStorage'

const TURBOQUANT_DEFAULT_ACTIVE_KEY = 'atomic_turboquant_default_active_v1'

/**
 * Runs once. Safe to call multiple times; subsequent invocations
 * short-circuit via the stored flag. Errors are caught and logged — a
 * migration failure must NEVER block app startup.
 */
export function runTurboquantDefaultMigration(): void {
  try {
    if (localStorage.getItem(TURBOQUANT_DEFAULT_ACTIVE_KEY) !== null) return
    const isExistingProfile =
      localStorage.getItem(localStorageKey.modelProvider) !== null ||
      localStorage.getItem(localStorageKey.setupCompleted) === 'true'
    localStorage.setItem(
      TURBOQUANT_DEFAULT_ACTIVE_KEY,
      isExistingProfile ? 'true' : 'false'
    )
    console.info(
      `[migration:turboquant-default] ${isExistingProfile ? 'existing profile: turboquant stays active' : 'fresh install: turboquant disabled by default'}`
    )
  } catch (err) {
    console.warn(
      '[migration:turboquant-default] migration failed (non-fatal):',
      err
    )
  }
}

/**
 * Default `active` value for the TurboQuant provider's first registration.
 * Falls back to `true` (pre-change behavior) when the flag is missing or
 * localStorage is unreadable.
 */
export function turboquantDefaultActive(): boolean {
  try {
    return localStorage.getItem(TURBOQUANT_DEFAULT_ACTIVE_KEY) !== 'false'
  } catch {
    return true
  }
}

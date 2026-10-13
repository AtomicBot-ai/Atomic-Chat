/**
 * Decides, once per profile, whether the TurboQuant `llamacpp` provider is
 * active by default. Runs in `main.tsx` *before* React mounts, because the
 * fresh-install check relies on the zustand `model-provider` blob not having
 * been written yet — later in startup `main.tsx` itself may write it (the
 * `preloadModelOnStartup` reset).
 *
 * Policy (decision D41): TurboQuant is ON by default — fresh installs and
 * existing profiles alike — re-disableable via the Settings → Model Providers
 * toggle. The verdict is frozen into a localStorage flag so the classification
 * never flips on later launches, and so a profile that already recorded the
 * earlier "disabled on fresh installs" verdict under the same key keeps it.
 */

const TURBOQUANT_DEFAULT_ACTIVE_KEY = 'atomic_turboquant_default_active_v1'

/**
 * Runs once. Safe to call multiple times; subsequent invocations
 * short-circuit via the stored flag. Errors are caught and logged — a
 * migration failure must NEVER block app startup.
 */
export function runTurboquantDefaultMigration(): void {
  try {
    if (localStorage.getItem(TURBOQUANT_DEFAULT_ACTIVE_KEY) !== null) return
    localStorage.setItem(TURBOQUANT_DEFAULT_ACTIVE_KEY, 'true')
    console.info(
      '[migration:turboquant-default] turboquant enabled by default (D41)'
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

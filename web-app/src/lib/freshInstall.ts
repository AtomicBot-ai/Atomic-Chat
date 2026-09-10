/**
 * Dev-only "launch as a brand-new user" mode (`make dev-fresh`, compile-time
 * flag `FRESH_INSTALL`). Both entry points run in `main.tsx` BEFORE React
 * mounts and before every startup migration, so the whole pre-mount pipeline
 * (turboquant default classification, provider store rehydration, onboarding
 * gate) sees exactly what a fresh install would see.
 *
 * A `FRESH_INSTALL` build clears webview localStorage once per app launch —
 * not per reload, or HMR / a manual refresh would reset mid-flow progress, so
 * a sessionStorage marker (which survives reloads but not an app restart)
 * scopes the wipe to the launch. The developer's real dev profile (provider
 * store, API keys, one-shot flags) is snapshotted into a backup entry first
 * and restored automatically on the next normal dev launch; changes made
 * during fresh runs are deliberately discarded. The shared on-disk data
 * folder (models, threads) is never touched.
 */

const BACKUP_KEY = '__atomic_fresh_install_backup_v1__'
const SESSION_MARKER = 'atomic_fresh_install_launch'

/**
 * FRESH_INSTALL builds only: back up the profile (first fresh launch only —
 * later fresh launches keep the original snapshot, discarding fresh-run
 * residue) and start this launch with an empty localStorage.
 */
export function runFreshInstallReset(): void {
  if (typeof FRESH_INSTALL === 'undefined' || !FRESH_INSTALL) return
  if (typeof window === 'undefined') return
  try {
    if (sessionStorage.getItem(SESSION_MARKER) !== null) return

    const backup =
      localStorage.getItem(BACKUP_KEY) ?? JSON.stringify(snapshotProfile())
    localStorage.clear()
    localStorage.setItem(BACKUP_KEY, backup)
    sessionStorage.setItem(SESSION_MARKER, 'true')
    console.info(
      '[fresh-install] localStorage cleared for this launch; original profile backed up'
    )
  } catch (err) {
    console.warn('[fresh-install] reset failed (non-fatal):', err)
  }
}

/**
 * Normal (non-FRESH_INSTALL) builds only: if a previous `make dev-fresh` run
 * left a backup behind, put the original profile back and drop everything the
 * fresh runs wrote. No-op forever in shipped builds — the backup entry can
 * only ever be written by a dev fresh-install build.
 */
export function restoreFreshInstallBackup(): void {
  if (typeof FRESH_INSTALL !== 'undefined' && FRESH_INSTALL) return
  if (typeof window === 'undefined') return
  try {
    const backup = localStorage.getItem(BACKUP_KEY)
    if (backup === null) return

    const entries = JSON.parse(backup) as Record<string, string>
    localStorage.clear()
    for (const [key, value] of Object.entries(entries)) {
      localStorage.setItem(key, value)
    }
    console.info(
      '[fresh-install] restored the original profile from the fresh-run backup'
    )
  } catch (err) {
    console.warn('[fresh-install] restore failed (non-fatal):', err)
  }
}

function snapshotProfile(): Record<string, string> {
  const entries: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key === null || key === BACKUP_KEY) continue
    const value = localStorage.getItem(key)
    if (value !== null) entries[key] = value
  }
  return entries
}

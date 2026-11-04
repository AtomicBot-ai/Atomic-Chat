import { listen } from '@tauri-apps/api/event'
import { isPlatformTauri } from '@/lib/platform/utils'

/**
 * Emitted by the shell shortly before it exits (`src-tauri/src/lib.rs`), after
 * it has closed the core's call gate. Anything started from then on fails with
 * CORE_NOT_RUNNING: a model auto-start fired during quit was the source of
 * those reports.
 */
export const APP_SHUTTING_DOWN_EVENT = 'app-shutting-down'

let shuttingDown = false
let listening = false

/** Whether the app has announced it is quitting. Never goes back to false. */
export function isAppShuttingDown(): boolean {
  return shuttingDown
}

/** Record the quit. Exported for the listener below and for tests. */
export function markAppShuttingDown(): void {
  shuttingDown = true
}

/** Start listening for the quit announcement; safe to call more than once. */
export function watchAppShutdown(): void {
  if (listening || !isPlatformTauri()) return
  listening = true
  listen(APP_SHUTTING_DOWN_EVENT, markAppShuttingDown).catch((error) => {
    listening = false
    console.debug('[app-shutdown] cannot listen for the quit event:', error)
  })
}

/** Test seam. */
export function resetAppShutdownForTests(): void {
  shuttingDown = false
  listening = false
}

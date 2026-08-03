/**
 * Detach a Tauri event listener at most once, swallowing the teardown error.
 *
 * Tauri's `_unlisten` reads `listeners[eventId].handlerId` and throws when the
 * entry is already gone. That happens whenever a listener registered by an
 * async effect is torn down twice — a fast unmount, StrictMode's double-invoke
 * or an HMR reload — and the rejection escapes as an unhandled promise.
 *
 * Returns a wrapper that is safe to call from both the async registration path
 * and the effect cleanup.
 */
export const createSafeUnlisten = (
  unlisten: () => void
): (() => Promise<void>) => {
  let detached = false

  return async () => {
    if (detached) return
    detached = true
    try {
      await unlisten()
    } catch (error) {
      console.warn('Failed to detach Tauri event listener', error)
    }
  }
}

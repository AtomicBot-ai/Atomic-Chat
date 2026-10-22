import { useCallback, useEffect } from 'react'

import { useServiceHub } from '@/hooks/useServiceHub'
import {
  API_SERVER_LOG_CLEAR_COMMAND,
  API_SERVER_LOG_SNAPSHOT_COMMAND,
  API_SERVER_LOG_SUBSCRIBE_COMMAND,
  API_SERVER_REQUEST_FINISHED_EVENT,
  API_SERVER_REQUEST_PROGRESS_EVENT,
  API_SERVER_REQUEST_STARTED_EVENT,
} from '@/types/apiServerLog'
import {
  normalizeFinishedPatch,
  normalizeProgressPatch,
  normalizeSnapshot,
  normalizeStarted,
} from '@/utils/apiServerLogNormalize'

import { useApiServerLog, type BatchOp } from './useApiServerLog'

/**
 * Subscribes the API screen to the proxy's live request channel.
 *
 * Mounted by the route only: a closed dashboard costs nothing, and the Rust
 * ring buffer is what fills the log back in when the user returns — it is kept
 * across unsubscribes for exactly that reason.
 *
 * Consequence worth knowing: prompt and reply previews are collected only
 * while someone watches. With the core serving the Local API, a request that
 * came while the screen was closed is still in the log, without previews; the
 * app's own proxy (mobile) records nothing then.
 *
 * The listeners are attached before the snapshot is read, and what they hear
 * while a snapshot is in flight is held and replayed on top of it: attached
 * after, a request that started between the read and the attach was in
 * neither, and stayed off the screen until it was opened again.
 */

// Module-level, deliberately outside React: a burst of events must not cause a
// render per event.
let queue: BatchOp[] = []
let frameScheduled = false
/** Snapshots being read; while any is, events wait in `held`. */
let snapshotsInFlight = 0
let held: BatchOp[] = []

function flushQueue() {
  frameScheduled = false
  const ops = queue
  queue = []
  if (ops.length > 0) useApiServerLog.getState().applyBatch(ops)
}

function schedule() {
  if (frameScheduled) return
  frameScheduled = true
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flushQueue)
  else setTimeout(flushQueue, 16)
}

function push(op: BatchOp) {
  if (snapshotsInFlight > 0) {
    held.push(op)
    return
  }
  queue.push(op)
  schedule()
}

/**
 * Replays what arrived during the snapshot, in arrival order. The snapshot may
 * already hold some of it: a repeated start is skipped (`applyBatch`), and a
 * patch sets the values the snapshot has, or newer ones.
 */
function releaseHeld() {
  if (snapshotsInFlight > 0 || held.length === 0) return
  queue.push(...held)
  held = []
  schedule()
}

export function resetFeedBuffers() {
  queue = []
  held = []
}

export function useApiServerLogFeed() {
  const serviceHub = useServiceHub()

  const hydrate = useCallback(async () => {
    const store = useApiServerLog.getState()
    snapshotsInFlight += 1
    try {
      const snapshot = await serviceHub
        .core()
        .invoke<unknown>(API_SERVER_LOG_SNAPSHOT_COMMAND)
      const { entries, droppedEvents } = normalizeSnapshot(snapshot)
      store.hydrate(entries, droppedEvents)
    } catch (error) {
      // Older backend, or the web build: the screen still works, it just has
      // no live telemetry to show.
      console.warn('API request log unavailable:', error)
      store.setFeedUnavailable(true)
    } finally {
      snapshotsInFlight -= 1
      releaseHeld()
    }
  }, [serviceHub])

  const clear = useCallback(async () => {
    resetFeedBuffers()
    useApiServerLog.getState().clear()
    try {
      await serviceHub.core().invoke(API_SERVER_LOG_CLEAR_COMMAND)
    } catch (error) {
      console.warn('Failed to clear the API request log:', error)
    }
  }, [serviceHub])

  useEffect(() => {
    let cancelled = false
    // Only a view that subscribed unsubscribes: the count is shared, and a
    // stray "off" would end another view's subscription.
    let subscribed = false
    const detachers: Array<() => void> = []

    const attach = async () => {
      const listeners = await Promise.all([
        serviceHub
          .events()
          .listen<unknown>(API_SERVER_REQUEST_STARTED_EVENT, (event) => {
            const entry = normalizeStarted(event.payload)
            if (entry) push({ t: 'start', entry })
          }),
        serviceHub
          .events()
          .listen<unknown>(API_SERVER_REQUEST_PROGRESS_EVENT, (event) => {
            const patch = normalizeProgressPatch(event.payload)
            if (patch) push({ t: 'patch', ...patch })
          }),
        serviceHub
          .events()
          .listen<unknown>(API_SERVER_REQUEST_FINISHED_EVENT, (event) => {
            const patch = normalizeFinishedPatch(event.payload)
            if (patch) push({ t: 'patch', ...patch })
          }),
      ])

      if (cancelled) {
        listeners.forEach((detach) => detach())
        return
      }
      detachers.push(...listeners)

      subscribed = true
      try {
        // Refcounted on the Rust side: previews are collected only while at
        // least one view is subscribed. The ring itself outlives the
        // subscription.
        await serviceHub
          .core()
          .invoke(API_SERVER_LOG_SUBSCRIBE_COMMAND, { enabled: true })
      } catch {
        // Fall through: hydrate() reports the unavailable feed.
      }
      if (cancelled) return

      await hydrate()
    }

    void attach()

    return () => {
      cancelled = true
      detachers.splice(0).forEach((detach) => detach())
      resetFeedBuffers()
      if (!subscribed) return
      serviceHub
        .core()
        .invoke(API_SERVER_LOG_SUBSCRIBE_COMMAND, { enabled: false })
        .catch(() => {
          // Unsubscribing is best-effort; a stale refcount only means the
          // backend keeps recording until the next unsubscribe.
        })
    }
  }, [hydrate, serviceHub])

  return { hydrate, clear }
}

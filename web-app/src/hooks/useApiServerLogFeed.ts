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
 * ring buffer is what fills the log back in when the user returns.
 */

// Module-level, deliberately outside React: a burst of events must not cause a
// render per event.
let queue: BatchOp[] = []
let frameScheduled = false

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
  queue.push(op)
  schedule()
}

export function resetFeedBuffers() {
  queue = []
}

export function useApiServerLogFeed() {
  const serviceHub = useServiceHub()

  const hydrate = useCallback(async () => {
    const store = useApiServerLog.getState()
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
    const detachers: Array<() => void> = []

    const attach = async () => {
      try {
        // Refcounted on the Rust side: recording only happens while at least
        // one view is subscribed, and the ring is wiped when the last one goes.
        await serviceHub
          .core()
          .invoke(API_SERVER_LOG_SUBSCRIBE_COMMAND, { enabled: true })
      } catch {
        // Fall through: hydrate() reports the unavailable feed.
      }

      await hydrate()
      if (cancelled) return

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
    }

    void attach()

    return () => {
      cancelled = true
      detachers.splice(0).forEach((detach) => detach())
      resetFeedBuffers()
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

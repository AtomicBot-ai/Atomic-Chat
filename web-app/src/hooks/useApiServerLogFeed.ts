import { useCallback, useEffect } from 'react'

import { useServiceHub } from '@/hooks/useServiceHub'
import { isPlatformTauri } from '@/lib/platform/utils'
import type { ServiceHub } from '@/services'
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
 * Feeds the Local API Server's request log into the webview.
 *
 * Two parts. The request channels are listened to for the whole app run
 * (`useApiServerLogLive`, mounted once at the root), so the log is current the
 * moment a Server page opens: listened to only while a page was mounted, the
 * store kept what it last showed, and a page opened after a request (Send test
 * request on Connections, then Activity) showed the old list until its
 * snapshot came back — "0 requests" until a manual Refresh.
 *
 * Watching is the pages' (`useApiServerLogFeed`): while Overview or Activity is
 * mounted the backend collects prompt and reply previews (ATO-113), and each
 * page reads the Rust ring on mount. With the core serving the Local API every
 * request is in the ring and on the channels — one that came while nobody
 * watched without previews, marked `unwatched`; the app's own proxy (mobile)
 * records nothing then.
 *
 * The listeners are attached before a snapshot is read, and what they hear
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

type LiveFeed = {
  refs: number
  /** Settles once the three listeners are attached. */
  ready: Promise<void>
  detachers: Array<() => void>
  closed: boolean
}

/** The one set of request-channel listeners, shared by everything that holds it. */
let live: LiveFeed | null = null

function openLiveFeed(serviceHub: ServiceHub): LiveFeed {
  const feed: LiveFeed = {
    refs: 0,
    ready: Promise.resolve(),
    detachers: [],
    closed: false,
  }
  const events = serviceHub.events()
  feed.ready = Promise.all([
    events.listen<unknown>(API_SERVER_REQUEST_STARTED_EVENT, (event) => {
      const entry = normalizeStarted(event.payload)
      if (entry) push({ t: 'start', entry })
    }),
    events.listen<unknown>(API_SERVER_REQUEST_PROGRESS_EVENT, (event) => {
      const patch = normalizeProgressPatch(event.payload)
      if (patch) push({ t: 'patch', ...patch })
    }),
    events.listen<unknown>(API_SERVER_REQUEST_FINISHED_EVENT, (event) => {
      const patch = normalizeFinishedPatch(event.payload)
      if (patch) push({ t: 'patch', ...patch })
    }),
  ]).then((detachers) => {
    // Released while still attaching: nobody is left to hear them.
    if (feed.closed) detachers.forEach((detach) => detach())
    else feed.detachers.push(...detachers)
  })
  return feed
}

/**
 * Holds the request channels open. The first holder attaches the listeners,
 * the last release detaches them and drops what was still queued.
 */
function retainLiveFeed(serviceHub: ServiceHub): {
  ready: Promise<void>
  release: () => void
} {
  live ??= openLiveFeed(serviceHub)
  const feed = live
  feed.refs += 1
  let released = false
  return {
    ready: feed.ready,
    release: () => {
      if (released) return
      released = true
      feed.refs -= 1
      if (feed.refs > 0) return
      feed.closed = true
      feed.detachers.splice(0).forEach((detach) => detach())
      if (live === feed) live = null
      resetFeedBuffers()
    },
  }
}

/**
 * Keeps the request log current for the whole app run, whether or not a
 * Server page is open. Mounted once, at the root (`GlobalEventHandler`). It
 * only listens: it does not ask the backend to collect previews.
 */
export function useApiServerLogLive() {
  const serviceHub = useServiceHub()

  useEffect(() => {
    if (!isPlatformTauri()) return
    return retainLiveFeed(serviceHub).release
  }, [serviceHub])
}

/**
 * A Server page that shows the log: watches (previews are collected while at
 * least one page does), reads the ring on mount, and offers refresh and clear.
 */
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
    // Usually already open (the root holds it); held here too so the page
    // never reads a snapshot it cannot hear the follow-up of.
    const feed = retainLiveFeed(serviceHub)

    const attach = async () => {
      await feed.ready
      if (cancelled) return

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
      feed.release()
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

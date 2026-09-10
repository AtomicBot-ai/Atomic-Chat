/**
 * Buffer for events emitted before PostHog is allowed to send anything.
 *
 * `AnalyticProvider` initialises PostHog with `opt_out_capturing_by_default:
 * true` and calls `opt_in_capturing()` only from the `.finally()` of an async
 * chain that first awaits the device's distinct id and then up to ~6s of
 * hardware IPC timeouts. posthog-js *drops* — it does not buffer — every
 * `capture()` made while opted out, so everything the app emitted during
 * startup was lost outright. `backend_step_shown` fires on mount of the very
 * first screen of a Windows first launch, i.e. squarely inside that window,
 * which explains its 6.1% coverage far better than the event's age does.
 *
 * Buffering here rather than opting in straight after `init()` is deliberate:
 * the device has to keep the `distinct_id` that `serviceHub.analytic()` owns,
 * or every early session would land on a separate anonymous id and the
 * per-device counting that this whole area depends on would split.
 */

import posthog from 'posthog-js'

type QueuedEvent = {
  event: string
  props: Record<string, unknown>
  timestamp: Date
}

/**
 * Small on purpose. Startup emits a handful of events; a queue that grows past
 * this is a bug elsewhere, and holding thousands of events to replay would
 * distort the very metrics they feed.
 */
const MAX_QUEUED = 50

const queue: QueuedEvent[] = []
let droppedBeforeFlush = 0
let flushed = false

/** `has_opted_in_capturing` throws if `init` has not run yet. */
function canSendNow(): boolean {
  try {
    return posthog.has_opted_in_capturing()
  } catch {
    return false
  }
}

/**
 * Capture an event, or hold it until consent has been applied.
 *
 * Every emitter in the app should go through this rather than
 * `posthog.capture` directly, so no event depends on winning a race with the
 * startup chain.
 */
export function queuedCapture(
  event: string,
  props: Record<string, unknown>
): void {
  try {
    if (flushed || canSendNow()) {
      posthog.capture(event, props)
      return
    }
    if (queue.length >= MAX_QUEUED) {
      droppedBeforeFlush += 1
      return
    }
    queue.push({ event, props, timestamp: new Date() })
  } catch (err) {
    console.debug(`${event} telemetry failed:`, err)
  }
}

/**
 * Replay everything held so far. Called once, immediately after
 * `posthog.opt_in_capturing()`.
 *
 * Events keep their original timestamps so funnel ordering survives the delay,
 * and carry `queued_ms` so the size of the startup window stays measurable
 * after the fix — if it ever grows again, the data says so.
 */
export function flushTelemetryQueue(): void {
  flushed = true
  const pending = queue.splice(0, queue.length)
  const dropped = droppedBeforeFlush
  droppedBeforeFlush = 0
  const now = Date.now()

  pending.forEach((item, index) => {
    try {
      posthog.capture(
        item.event,
        {
          ...item.props,
          queued_ms: Math.max(0, now - item.timestamp.getTime()),
          // Only on the first replayed event: a non-zero value means the queue
          // overflowed and this session is missing events.
          ...(index === 0 && dropped > 0
            ? { dropped_before_flush: dropped }
            : {}),
        },
        { timestamp: item.timestamp }
      )
    } catch (err) {
      console.debug(`${item.event} telemetry replay failed:`, err)
    }
  })
}

/** Test seam — drops any held events and re-arms the queue. */
export function resetTelemetryQueueForTests(): void {
  queue.length = 0
  droppedBeforeFlush = 0
  flushed = false
}

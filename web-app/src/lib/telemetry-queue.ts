/**
 * Buffer for events emitted before the analytics provider is ready.
 *
 * `AnalyticProvider` initializes PostHog opted out, restores the install's
 * identity, applies consent, and collects cohort/hardware properties before
 * flushing. PostHog drops captures before init or while opted out; its consent
 * getter can nevertheless return true before init. Only the provider knows
 * when events can be sent with the correct identity and properties.
 *
 * Keeping that boundary explicit prevents early events from landing on a
 * temporary anonymous id. Disabled analytics discards pending activity rather
 * than keeping it for a later opt-in.
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
let state: 'buffering' | 'ready' | 'disabled' = 'buffering'

/** Re-arm the readiness boundary when the provider initializes again. */
export function bufferTelemetryUntilReady(): void {
  state = 'buffering'
}

/** Do not retain opted-out activity for a later opt-in. */
export function disableTelemetryQueue(): void {
  state = 'disabled'
  queue.length = 0
  droppedBeforeFlush = 0
}

/**
 * Capture an event, or hold it until the provider has restored the identity,
 * applied consent and registered the super-properties. SDK consent is not a
 * readiness check: posthog-js 1.255.1 returns true before init, but silently
 * drops capture calls in that state.
 *
 * Every emitter in the app should go through this rather than
 * `posthog.capture` directly, so no event depends on winning a race with the
 * startup chain.
 */
export function queuedCapture(
  event: string,
  props: Record<string, unknown>
): void {
  if (state === 'disabled') return
  try {
    if (state === 'ready') {
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
 * Replay everything held so far and explicitly allow subsequent captures.
 * Called by AnalyticProvider after identity, consent and super-properties.
 * PostHog still enforces consent on each capture after this boundary.
 *
 * Events keep their original timestamps so funnel ordering survives the delay,
 * and carry `queued_ms` so the size of the startup window stays measurable
 * after the fix — if it ever grows again, the data says so.
 */
export function flushTelemetryQueue(): void {
  if (state === 'disabled') return
  state = 'ready'
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
  state = 'buffering'
}

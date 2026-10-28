import { beforeEach, describe, expect, it, vi } from 'vitest'

import posthog from 'posthog-js'
import {
  bufferTelemetryUntilReady,
  disableTelemetryQueue,
  flushTelemetryQueue,
  queuedCapture,
  resetTelemetryQueueForTests,
} from '@/lib/telemetry-queue'

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), has_opted_in_capturing: vi.fn() },
}))

const capture = () => vi.mocked(posthog.capture)
const optedIn = (value: boolean) =>
  vi.mocked(posthog.has_opted_in_capturing).mockReturnValue(value)

beforeEach(() => {
  vi.mocked(posthog.capture).mockClear()
  vi.mocked(posthog.has_opted_in_capturing).mockReset()
  resetTelemetryQueueForTests()
})

describe('queuedCapture', () => {
  it('sends straight through once the provider declares readiness', () => {
    optedIn(true)
    flushTelemetryQueue()

    queuedCapture('app_opened', { is_first_launch: true })

    expect(capture()).toHaveBeenCalledWith('app_opened', {
      is_first_launch: true,
    })

    // Nothing was held back: a later flush has no copy of it to replay.
    flushTelemetryQueue()
    expect(capture().mock.calls).toEqual([
      ['app_opened', { is_first_launch: true }],
    ])
  })

  it('holds events emitted before opt-in instead of dropping them', () => {
    optedIn(false)

    queuedCapture('backend_step_shown', { phase: 'detecting' })

    expect(capture()).not.toHaveBeenCalled()

    // Held, not dropped: consent replays exactly that event.
    optedIn(true)
    flushTelemetryQueue()
    const calls = capture().mock.calls
    expect(calls.map((call) => call[0])).toEqual(['backend_step_shown'])
    expect(calls[0][1]).toMatchObject({ phase: 'detecting' })
  })

  it('waits for provider readiness even when SDK consent already reads true', () => {
    // This is the real SDK's pre-init result, not a signal that capture works.
    optedIn(true)
    queuedCapture('onboarding_step_shown', { step: 'welcome' })
    expect(capture()).not.toHaveBeenCalled()

    flushTelemetryQueue()
    expect(capture()).toHaveBeenCalledTimes(1)
    expect(capture().mock.calls[0][0]).toBe('onboarding_step_shown')
  })
})

describe('flushTelemetryQueue', () => {
  it('discards pending and opted-out activity before analytics is enabled again', () => {
    queuedCapture('before_consent_loaded', {})
    disableTelemetryQueue()
    queuedCapture('while_disabled', {})
    flushTelemetryQueue()
    expect(capture().mock.calls).toEqual([])

    bufferTelemetryUntilReady()
    queuedCapture('after_opt_in', { step: 'model' })
    expect(capture().mock.calls).toEqual([])
    flushTelemetryQueue()
    expect(capture().mock.calls.map(([event]) => event)).toEqual([
      'after_opt_in',
    ])
  })

  it('buffers again while a new initialization restores identity and properties', () => {
    flushTelemetryQueue()
    bufferTelemetryUntilReady()
    queuedCapture('during_reinitialization', { step: 'model' })
    expect(capture().mock.calls).toEqual([])

    flushTelemetryQueue()
    expect(capture().mock.calls.map(([event]) => event)).toEqual([
      'during_reinitialization',
    ])
  })

  it('replays held events in order, with their original timestamps', () => {
    optedIn(false)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    queuedCapture('backend_step_shown', { phase: 'detecting' })
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'))
    queuedCapture('setup_screen_shown', { rendered: true })
    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'))

    optedIn(true)
    flushTelemetryQueue()

    const calls = capture().mock.calls
    expect(calls.map((call) => call[0])).toEqual([
      'backend_step_shown',
      'setup_screen_shown',
    ])
    expect(calls[0][1]).toMatchObject({ phase: 'detecting', queued_ms: 5000 })
    expect(calls[1][1]).toMatchObject({ rendered: true, queued_ms: 3000 })
    expect(calls[0][2]).toEqual({
      timestamp: new Date('2026-01-01T00:00:00Z'),
    })
    vi.useRealTimers()
  })

  it('reports how many events the queue had to drop', () => {
    optedIn(false)
    for (let i = 0; i < 60; i += 1) {
      queuedCapture('model_load', { attempt: i })
    }

    optedIn(true)
    flushTelemetryQueue()

    const calls = capture().mock.calls
    expect(calls).toHaveLength(50)
    expect(calls[0][1]).toMatchObject({ dropped_before_flush: 10 })
    // Only the first replayed event carries the count.
    expect(calls[1][1]).not.toHaveProperty('dropped_before_flush')
  })

  it('sends directly after a flush, without re-queuing', () => {
    optedIn(false)
    queuedCapture('backend_step_shown', { phase: 'detecting' })
    optedIn(true)
    flushTelemetryQueue()
    capture().mockClear()

    // PostHog enforces later consent changes; do not retain opted-out activity
    // for replay if the user opts back in.
    optedIn(false)
    queuedCapture('model_load', { load_status: 'success' })

    expect(capture()).toHaveBeenCalledWith('model_load', {
      load_status: 'success',
    })

    // Sent once, as-is: no replay metadata, and a second flush finds nothing.
    flushTelemetryQueue()
    expect(capture().mock.calls).toEqual([
      ['model_load', { load_status: 'success' }],
    ])
  })

  it('keeps replaying after one event throws', () => {
    optedIn(false)
    queuedCapture('first', {})
    queuedCapture('second', {})
    optedIn(true)
    capture().mockImplementationOnce(() => {
      throw new Error('transport down')
    })

    expect(() => flushTelemetryQueue()).not.toThrow()
    expect(capture()).toHaveBeenCalledTimes(2)
  })
})

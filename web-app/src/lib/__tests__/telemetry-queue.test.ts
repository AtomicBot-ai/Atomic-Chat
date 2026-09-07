import { beforeEach, describe, expect, it, vi } from 'vitest'

import posthog from 'posthog-js'
import {
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
  it('sends straight through once consent has been applied', () => {
    optedIn(true)

    queuedCapture('app_opened', { is_first_launch: true })

    expect(capture()).toHaveBeenCalledWith('app_opened', {
      is_first_launch: true,
    })
  })

  it('holds events emitted before opt-in instead of dropping them', () => {
    optedIn(false)

    queuedCapture('backend_step_shown', { phase: 'detecting' })

    expect(capture()).not.toHaveBeenCalled()
  })

  it('holds events when posthog has not been initialised at all', () => {
    vi.mocked(posthog.has_opted_in_capturing).mockImplementation(() => {
      throw new Error('You must initialize PostHog before calling this method')
    })

    queuedCapture('backend_step_shown', { phase: 'detecting' })
    optedIn(true)
    flushTelemetryQueue()

    expect(capture()).toHaveBeenCalledTimes(1)
  })
})

describe('flushTelemetryQueue', () => {
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

    // Consent can never be withdrawn mid-session without a reload, so once the
    // queue has drained it must not start holding events again.
    optedIn(false)
    queuedCapture('model_load', { load_status: 'success' })

    expect(capture()).toHaveBeenCalledWith('model_load', {
      load_status: 'success',
    })
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

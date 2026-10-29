import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import posthog from 'posthog-js'

import {
  flushTelemetryQueue,
  queuedCapture,
  resetTelemetryQueueForTests,
} from '@/lib/telemetry-queue'

beforeEach(() => {
  resetTelemetryQueueForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

it('buffers against the real uninitialized SDK despite its opted-in result', () => {
  // Keep the installed SDK's real consent implementation. The old mock threw
  // before init and concealed the production drop in posthog-js 1.255.1.
  expect(posthog.has_opted_in_capturing()).toBe(true)
  const capture = vi.spyOn(posthog, 'capture')

  queuedCapture('onboarding_step_shown', { step: 'welcome' })

  expect(capture).not.toHaveBeenCalled()
  flushTelemetryQueue()
  expect(capture).toHaveBeenCalledExactlyOnceWith(
    'onboarding_step_shown',
    expect.objectContaining({ step: 'welcome', queued_ms: expect.any(Number) }),
    { timestamp: expect.any(Date) }
  )
  flushTelemetryQueue()
  expect(capture).toHaveBeenCalledTimes(1)
})

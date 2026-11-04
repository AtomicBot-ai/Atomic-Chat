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

it('flushes on shutdown through the installed SDK API, not a guessed one', async () => {
  // `_handle_unload` drains posthog-js's batch and retry queues with
  // sendBeacon; `request_batching` is what makes later captures skip the
  // 3 s batch. Both exist on posthog-js 1.255.1.
  const { flushTelemetryForShutdown } = await import('@/lib/telemetry-queue')
  expect(typeof posthog._handle_unload).toBe('function')
  const unload = vi.spyOn(posthog, '_handle_unload')
  const setConfig = vi.spyOn(posthog, 'set_config')

  flushTelemetryQueue()
  expect(() => flushTelemetryForShutdown()).not.toThrow()

  expect(unload).toHaveBeenCalledTimes(1)
  expect(setConfig).toHaveBeenCalledWith({ request_batching: false })
  expect(posthog.config.request_batching).toBe(false)
})

/** Use in emitter/UI tests that start after AnalyticProvider is ready. */
import { beforeEach } from 'vitest'
import {
  flushTelemetryQueue,
  resetTelemetryQueueForTests,
} from '@/lib/telemetry-queue'

beforeEach(() => {
  resetTelemetryQueueForTests()
  flushTelemetryQueue()
})

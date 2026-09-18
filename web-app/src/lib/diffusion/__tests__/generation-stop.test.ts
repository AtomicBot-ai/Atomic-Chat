import { describe, expect, it } from 'vitest'

import {
  shouldContinueGenerating,
  shouldReportGenerateError,
} from '../generation-stop'

describe('shouldContinueGenerating', () => {
  it.each([
    // [stopRequested, jobState, run, runsTotal, expected]
    [false, 'completed', 0, 3, true],
    [false, 'completed', 1, 3, true],
    [false, 'completed', 2, 3, false],
    [false, 'completed', 0, 1, false],
    [true, 'completed', 0, 3, false],
    [false, 'failed', 0, 3, false],
    [false, 'cancelled', 0, 3, false],
  ] as const)(
    'stop=%s state=%s run=%i of %i → %s',
    (stopRequested, jobState, run, runsTotal, expected) => {
      expect(
        shouldContinueGenerating({ stopRequested, jobState, run, runsTotal })
      ).toBe(expected)
    }
  )
})

describe('shouldReportGenerateError', () => {
  it('never toasts a cancellation the user asked for', () => {
    expect(
      shouldReportGenerateError({ code: 'CANCELLED', stopRequested: true })
    ).toBe(false)
  })

  it('does report a cancellation nobody asked for', () => {
    expect(
      shouldReportGenerateError({ code: 'CANCELLED', stopRequested: false })
    ).toBe(true)
  })

  it('reports real failures even after Stop', () => {
    expect(
      shouldReportGenerateError({ code: 'OUT_OF_MEMORY', stopRequested: true })
    ).toBe(true)
  })

  it('has nothing to say without a code', () => {
    expect(shouldReportGenerateError({ code: null, stopRequested: false })).toBe(false)
    expect(
      shouldReportGenerateError({ code: undefined, stopRequested: true })
    ).toBe(false)
  })
})

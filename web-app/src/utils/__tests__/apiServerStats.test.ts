import { describe, expect, it } from 'vitest'

import type { ApiLogEntry, ApiRequestEntry } from '@/types/apiServerLog'

import {
  RECENT_WINDOW_MS,
  computeApiServerStats,
  formatCount,
  formatMs,
  formatTokensPerSecond,
} from '../apiServerStats'

const NOW = 1_700_000_000_000

function request(overrides: Partial<ApiRequestEntry> = {}): ApiRequestEntry {
  return {
    kind: 'request',
    id: Math.random().toString(36).slice(2),
    seq: 0,
    startedAt: NOW - 1000,
    status: 'completed',
    method: 'POST',
    endpoint: 'chat/completions',
    model: 'm',
    stream: true,
    durationMs: 1000,
    ...overrides,
  }
}

const stats = (entries: ApiLogEntry[]) => computeApiServerStats(entries, NOW)

describe('computeApiServerStats', () => {
  it('returns an all-empty result for no entries', () => {
    expect(stats([])).toEqual({
      inFlight: 0,
      windowRequests: 0,
      completed: 0,
      errors: 0,
      errorPctOfFinished: null,
      avgLatencyMs: null,
      maxLatencyMs: null,
      throughputTps: null,
      windowCompletionTokens: 0,
      windowGenerationMs: 0,
    })
  })

  it('counts in-flight requests even when they started before the window', () => {
    const result = stats([
      request({ status: 'in_flight', startedAt: NOW - RECENT_WINDOW_MS - 60_000 }),
    ])
    expect(result.inFlight).toBe(1)
    // ...but they are not part of the window totals.
    expect(result.windowRequests).toBe(0)
  })

  it('excludes entries older than the window', () => {
    const result = stats([
      request({ startedAt: NOW - RECENT_WINDOW_MS - 1 }),
      request({ startedAt: NOW - RECENT_WINDOW_MS + 1 }),
    ])
    expect(result.windowRequests).toBe(1)
    expect(result.completed).toBe(1)
  })

  it('ignores non-request rows', () => {
    const notice: ApiLogEntry = {
      kind: 'event',
      id: 'n',
      seq: -1,
      startedAt: NOW,
      level: 'info',
      title: 'Model loaded',
    }
    expect(stats([notice]).windowRequests).toBe(0)
  })

  it('computes the error share of finished requests, excluding cancelled', () => {
    const result = stats([
      request({ status: 'completed' }),
      request({ status: 'completed' }),
      request({ status: 'error' }),
      request({ status: 'cancelled' }),
    ])
    expect(result.completed).toBe(2)
    expect(result.errors).toBe(1)
    // 1 error out of 3 finished — the cancelled row is not "finished".
    expect(result.errorPctOfFinished).toBeCloseTo(33.33, 1)
  })

  it('leaves the error share null when nothing has finished', () => {
    expect(stats([request({ status: 'in_flight' })]).errorPctOfFinished).toBeNull()
  })

  it('averages and maxes latency over completed requests only', () => {
    const result = stats([
      request({ durationMs: 1000 }),
      request({ durationMs: 3000 }),
      request({ status: 'error', durationMs: 90_000 }),
    ])
    expect(result.avgLatencyMs).toBe(2000)
    expect(result.maxLatencyMs).toBe(3000)
  })

  it('computes throughput over generation time, excluding time to first token', () => {
    // 150 tokens generated in (3500 - 500) ms => 50 tok/s
    const result = stats([
      request({ completionTokens: 150, durationMs: 3500, ttftMs: 500 }),
    ])
    expect(result.windowCompletionTokens).toBe(150)
    expect(result.windowGenerationMs).toBe(3000)
    expect(result.throughputTps).toBeCloseTo(50, 5)
  })

  it('falls back to the whole duration when time to first token is unknown', () => {
    const result = stats([request({ completionTokens: 100, durationMs: 2000 })])
    expect(result.throughputTps).toBeCloseTo(50, 5)
  })

  it('aggregates throughput over the window rather than averaging rates', () => {
    // A 1-token request at 100 tok/s must not drag a 900-token request at
    // 90 tok/s up to a 95 tok/s mean.
    const result = stats([
      request({ completionTokens: 1, durationMs: 10, ttftMs: 0 }),
      request({ completionTokens: 900, durationMs: 10_000, ttftMs: 0 }),
    ])
    expect(result.throughputTps).toBeCloseTo(901 / 10.01, 3)
  })

  it('leaves throughput null when no tokens were generated', () => {
    expect(stats([request({ durationMs: 1000 })]).throughputTps).toBeNull()
  })
})

describe('formatters', () => {
  it('formats durations by magnitude', () => {
    expect(formatMs(346)).toBe('346 ms')
    expect(formatMs(3500)).toBe('3.5 s')
    expect(formatMs(125_000)).toBe('2m 5s')
    expect(formatMs(null)).toBe('–')
    expect(formatMs(undefined)).toBe('–')
  })

  it('formats rates and counts', () => {
    expect(formatTokensPerSecond(55.63)).toBe('55.6 tok/s')
    expect(formatTokensPerSecond(null)).toBe('–')
    expect(formatCount(4096)).toBe('4 096')
    expect(formatCount(0)).toBe('0')
    expect(formatCount(null)).toBe('–')
  })
})

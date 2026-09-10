/**
 * Derived header statistics for the API dashboard. Pure over the log so the
 * store never has to keep a second, drift-prone aggregate.
 */

import type { ApiLogEntry, ApiRequestEntry } from '@/types/apiServerLog'

export const RECENT_WINDOW_MS = 5 * 60 * 1000

export type ApiServerStats = {
  inFlight: number
  windowRequests: number
  completed: number
  errors: number
  /** Share of *finished* requests that failed; `null` when none finished. */
  errorPctOfFinished: number | null
  avgLatencyMs: number | null
  maxLatencyMs: number | null
  throughputTps: number | null
  windowCompletionTokens: number
  windowGenerationMs: number
}

const EMPTY: ApiServerStats = {
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
}

export function computeApiServerStats(
  entries: readonly ApiLogEntry[],
  now: number,
  windowMs: number = RECENT_WINDOW_MS
): ApiServerStats {
  const stats: ApiServerStats = { ...EMPTY }
  const cutoff = now - windowMs
  let latencySum = 0
  let latencyCount = 0

  for (const entry of entries) {
    if (entry.kind !== 'request') continue
    const request = entry as ApiRequestEntry

    // In-flight is counted regardless of the window: a ten-minute stream
    // started before the cutoff is still occupying a slot right now.
    if (request.status === 'in_flight') stats.inFlight += 1

    if (request.startedAt < cutoff) continue
    stats.windowRequests += 1

    if (request.status === 'completed') {
      stats.completed += 1
      if (typeof request.durationMs === 'number') {
        latencySum += request.durationMs
        latencyCount += 1
        stats.maxLatencyMs = Math.max(
          stats.maxLatencyMs ?? 0,
          request.durationMs
        )
      }
      if (request.completionTokens) {
        stats.windowCompletionTokens += request.completionTokens
        // Generation time excludes the wait for the first token; falling back
        // to the whole duration when TTFT is unknown keeps the rate honest
        // rather than optimistic.
        const generation =
          typeof request.durationMs === 'number'
            ? Math.max(request.durationMs - (request.ttftMs ?? 0), 1)
            : 0
        stats.windowGenerationMs += generation
      }
    } else if (request.status === 'error') {
      stats.errors += 1
    }
  }

  const finished = stats.completed + stats.errors
  if (finished > 0) {
    stats.errorPctOfFinished = (stats.errors / finished) * 100
  }
  if (latencyCount > 0) {
    stats.avgLatencyMs = latencySum / latencyCount
  }
  if (stats.windowCompletionTokens > 0 && stats.windowGenerationMs > 0) {
    // A window aggregate, not a mean of per-request rates: short replies must
    // not skew it the way averaging tok/s would.
    stats.throughputTps =
      stats.windowCompletionTokens / (stats.windowGenerationMs / 1000)
  }
  return stats
}

/** `1.9 s`, `346 ms`, `–`. */
export function formatMs(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '–'
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function formatTokensPerSecond(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '–'
  return `${value.toFixed(1)} tok/s`
}

/** Thin-space grouping, matching how the reference dashboard reads. */
export function formatCount(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '–'
  return Math.round(value).toLocaleString('en-US').replace(/,/g, ' ')
}

export function formatTime(epochMs?: number): string {
  if (!epochMs) return '–'
  return new Date(epochMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

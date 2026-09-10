/**
 * The single boundary between the Rust inspector's wire shape and the app's
 * domain types. Deliberately tolerant of both snake_case and camelCase keys so
 * a wire rename cannot break the screen — only this file would change.
 */

import type {
  ApiEventEntry,
  ApiLogEntry,
  ApiRequestEntry,
  ApiRequestPatch,
  ApiRequestStatus,
} from '@/types/apiServerLog'

/** Previews are already capped in Rust; this is defence in depth. */
export const PREVIEW_MAX_CHARS = 400

type Raw = Record<string, unknown>

const asRecord = (value: unknown): Raw | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Raw)
    : null

/** Reads the first present key, accepting snake_case and camelCase spellings. */
function pick(raw: Raw, keys: string[]): unknown {
  for (const key of keys) {
    const value = raw[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

const pickString = (raw: Raw, keys: string[]): string | undefined => {
  const value = pick(raw, keys)
  return typeof value === 'string' ? value : undefined
}

const pickNumber = (raw: Raw, keys: string[]): number | undefined => {
  const value = pick(raw, keys)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const pickBool = (raw: Raw, keys: string[]): boolean | undefined => {
  const value = pick(raw, keys)
  return typeof value === 'boolean' ? value : undefined
}

export function truncatePreview(value?: string): string | undefined {
  if (!value) return undefined
  return value.length > PREVIEW_MAX_CHARS
    ? `${value.slice(0, PREVIEW_MAX_CHARS)}…`
    : value
}

/**
 * Turns the proxy's endpoint label into the path a client would call.
 * The proxy reports `chat/completions`; a user reading the log expects
 * `/v1/chat/completions`.
 */
export function endpointPath(endpoint: string, apiPrefix = '/v1'): string {
  const prefix = apiPrefix.startsWith('/') ? apiPrefix : `/${apiPrefix}`
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return `${trimmed}/${endpoint.replace(/^\//, '')}`
}

/** The short label shown in the list. */
export const endpointLabel = (endpoint: string): string =>
  endpoint === 'other' ? endpoint : `/${endpoint.replace(/^\//, '')}`

function statusFor(raw: Raw): ApiRequestStatus {
  if (pickBool(raw, ['aborted'])) return 'cancelled'
  if (pickString(raw, ['error_kind', 'errorKind'])) return 'error'
  const http = pickNumber(raw, ['status', 'http_status', 'httpStatus'])
  if (http === undefined) return 'in_flight'
  return http >= 400 ? 'error' : 'completed'
}

export function normalizeStarted(payload: unknown): ApiRequestEntry | null {
  const raw = asRecord(payload)
  if (!raw) return null
  const id = pickString(raw, ['id', 'request_id', 'requestId'])
  if (!id) return null
  return {
    kind: 'request',
    id,
    seq: pickNumber(raw, ['seq']) ?? 0,
    startedAt: pickNumber(raw, ['started_at_ms', 'startedAtMs', 'startedAt']) ?? Date.now(),
    status: 'in_flight',
    method: (pickString(raw, ['method']) ?? 'POST').toUpperCase(),
    endpoint: pickString(raw, ['endpoint']) ?? 'other',
    model: pickString(raw, ['model_id', 'modelId', 'model']) ?? null,
    stream: pickBool(raw, ['stream']) ?? false,
    messageCount: pickNumber(raw, ['message_count', 'messageCount']),
    promptPreview: truncatePreview(
      pickString(raw, ['prompt_preview', 'promptPreview'])
    ),
    promptChars: pickNumber(raw, ['prompt_chars', 'promptChars']),
    hasNonTextParts: pickBool(raw, ['has_non_text_parts', 'hasNonTextParts']),
  }
}

export function normalizeFinishedPatch(
  payload: unknown
): { id: string; patch: ApiRequestPatch } | null {
  const raw = asRecord(payload)
  if (!raw) return null
  const id = pickString(raw, ['id', 'request_id', 'requestId'])
  if (!id) return null
  return {
    id,
    patch: {
      status: statusFor(raw),
      endedAt: pickNumber(raw, ['finished_at_ms', 'finishedAtMs']),
      httpStatus: pickNumber(raw, ['status', 'http_status', 'httpStatus']),
      errorKind: pickString(raw, ['error_kind', 'errorKind']),
      aborted: pickBool(raw, ['aborted']),
      headersMs: pickNumber(raw, ['headers_ms', 'headersMs']),
      ttftMs: pickNumber(raw, ['ttft_ms', 'ttftMs']),
      durationMs: pickNumber(raw, ['duration_ms', 'durationMs']),
      promptTokens: pickNumber(raw, ['prompt_tokens', 'promptTokens']),
      completionTokens: pickNumber(raw, ['completion_tokens', 'completionTokens']),
      totalTokens: pickNumber(raw, ['total_tokens', 'totalTokens']),
      tokensEstimated: pickBool(raw, ['tokens_estimated', 'tokensEstimated']),
      promptPerSecond: pickNumber(raw, ['prompt_per_second', 'promptPerSecond']),
      predictedPerSecond: pickNumber(raw, [
        'predicted_per_second',
        'predictedPerSecond',
      ]),
      finishReason: pickString(raw, ['finish_reason', 'finishReason']),
      replyPreview: truncatePreview(
        pickString(raw, ['reply_preview', 'replyPreview'])
      ),
      replyChars: pickNumber(raw, ['reply_chars', 'replyChars']),
    },
  }
}

export function normalizeProgressPatch(
  payload: unknown
): { id: string; patch: ApiRequestPatch } | null {
  const raw = asRecord(payload)
  if (!raw) return null
  const id = pickString(raw, ['id', 'request_id', 'requestId'])
  if (!id) return null
  return {
    id,
    patch: {
      ttftMs: pickNumber(raw, ['ttft_ms', 'ttftMs']),
      completionTokens: pickNumber(raw, ['completion_tokens', 'completionTokens']),
      replyChars: pickNumber(raw, ['reply_chars', 'replyChars']),
      durationMs: pickNumber(raw, ['elapsed_ms', 'elapsedMs']),
    },
  }
}

/** A record from `get_api_request_log`: started and finished fields merged. */
export function normalizeRecord(payload: unknown): ApiRequestEntry | null {
  const started = normalizeStarted(payload)
  if (!started) return null
  const raw = asRecord(payload)
  if (!raw || !pickBool(raw, ['done'])) return started
  const finished = normalizeFinishedPatch(payload)
  return finished ? { ...started, ...stripUndefined(finished.patch) } : started
}

export function normalizeSnapshot(payload: unknown): {
  entries: ApiLogEntry[]
  inFlight: number
  droppedEvents: number
} {
  const raw = asRecord(payload)
  const records = raw?.records
  const entries = Array.isArray(records)
    ? (records.map(normalizeRecord).filter(Boolean) as ApiLogEntry[])
    : []
  return {
    // The command returns oldest-first; the store is newest-first.
    entries: entries.reverse(),
    inFlight: raw ? (pickNumber(raw, ['in_flight', 'inFlight']) ?? 0) : 0,
    droppedEvents: raw ? (pickNumber(raw, ['dropped_events', 'droppedEvents']) ?? 0) : 0,
  }
}

export function makeNotice(
  id: string,
  title: string,
  detail?: string,
  level: ApiEventEntry['level'] = 'info'
): ApiEventEntry {
  return { kind: 'event', id, seq: -1, startedAt: Date.now(), level, title, detail }
}

/** Drops `undefined` values so a patch never overwrites a known field. */
export function stripUndefined<T extends object>(patch: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value
  }
  return out as Partial<T>
}

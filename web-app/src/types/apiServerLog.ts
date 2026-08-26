/**
 * Domain types for the live Local API Server request log.
 *
 * The wire shape comes from `src-tauri/src/core/server/request_inspector.rs`.
 * Nothing outside `utils/apiServerLogNormalize.ts` should touch that shape —
 * everything else works against the types below.
 *
 * PRIVACY: `promptPreview` / `replyPreview` are user prompt and model output
 * text. They live in memory only — the store is deliberately not persisted,
 * and these fields must never be forwarded to analytics. See the note in
 * `types/analytics.ts` about why the inspector uses its own event namespace.
 */

export type ApiRequestStatus = 'in_flight' | 'completed' | 'error' | 'cancelled'

export type ApiRequestEntry = {
  kind: 'request'
  id: string
  seq: number
  startedAt: number
  endedAt?: number
  status: ApiRequestStatus
  method: string
  /** Endpoint label from the proxy, e.g. `chat/completions`. */
  endpoint: string
  model: string | null
  stream: boolean
  messageCount?: number
  promptPreview?: string
  promptChars?: number
  hasNonTextParts?: boolean
  replyPreview?: string
  replyChars?: number
  ttftMs?: number
  headersMs?: number
  durationMs?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /** Completion tokens were counted from deltas, not reported upstream. */
  tokensEstimated?: boolean
  promptPerSecond?: number
  predictedPerSecond?: number
  finishReason?: string
  httpStatus?: number
  errorKind?: string
  aborted?: boolean
}

/** A non-request row in the log, e.g. "Model loaded". */
export type ApiEventEntry = {
  kind: 'event'
  id: string
  seq: number
  startedAt: number
  level: 'info' | 'warn' | 'error'
  title: string
  detail?: string
}

export type ApiLogEntry = ApiRequestEntry | ApiEventEntry

export type ApiLogFilter =
  | 'all'
  | 'in_flight'
  | 'completed'
  | 'errors'
  | 'cancelled'

/** Partial update applied to an existing request row. */
export type ApiRequestPatch = Partial<Omit<ApiRequestEntry, 'kind' | 'id'>>

export const API_SERVER_REQUEST_STARTED_EVENT = 'api-inspector://request-started'
export const API_SERVER_REQUEST_PROGRESS_EVENT =
  'api-inspector://request-progress'
export const API_SERVER_REQUEST_FINISHED_EVENT =
  'api-inspector://request-finished'

export const API_SERVER_LOG_SNAPSHOT_COMMAND = 'get_api_request_log'
export const API_SERVER_LOG_SUBSCRIBE_COMMAND = 'set_api_inspector_enabled'
export const API_SERVER_LOG_CLEAR_COMMAND = 'clear_api_request_log'

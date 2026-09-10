/**
 * Immediate bind-failure payload. Normal Local API Server requests are emitted
 * through the aggregated session-summary event below.
 */
export type ApiServerRequestEvent = {
  source: 'local_api_server'
  endpoint:
    | 'chat/completions'
    | 'responses'
    | 'messages'
    | 'completions'
    | 'embeddings'
    | 'messages/count_tokens'
    | 'models'
    | 'metrics'
    | 'other'
  method: 'GET' | 'POST' | 'BIND'
  model_id: string | null
  backend: 'llamacpp' | 'llamacpp-upstream' | 'mlx' | 'remote' | 'unknown' | ''
  provider: string | null
  stream: boolean
  status: number
  latency_ms: number
  is_anthropic_fallback: boolean
  error_kind:
    | 'auth'
    | 'host'
    | 'bad_request'
    | 'not_found'
    | 'method_not_allowed'
    | 'local_model_error'
    | 'local_model_unreachable'
    | 'remote_provider_error'
    | 'proxy_internal'
    | 'server_bind_failed'
    | null
  // ATO-112: error-breakdown fields populated on failure paths.
  upstream_status?: number | null
  oom_detected?: boolean
  ctx_overflow_detected?: boolean
  server_bind_failed?: boolean
}

export const API_SERVER_REQUEST_EVENT = 'analytics://api_server_request'

export type ApiServerSessionSummaryEvent = {
  source: 'local_api_server'
  window_started_at_ms: number
  window_ended_at_ms: number
  window_duration_ms: number
  request_count: number
  success_count: number
  client_error_count: number
  server_error_count: number
  other_status_count: number
  latency_sum_ms: number
  latency_avg_ms: number
  latency_max_ms: number
  stream_request_count: number
  anthropic_fallback_count: number
  oom_count: number
  ctx_overflow_count: number
  endpoint_counts: Record<string, number>
  method_counts: Record<string, number>
  backend_counts: Record<string, number>
  provider_counts: Record<string, number>
  status_counts: Record<string, number>
  upstream_status_counts: Record<string, number>
  error_kind_counts: Record<string, number>
  models_used: string[]
}

export const API_SERVER_SESSION_SUMMARY_EVENT =
  'analytics://api_server_session_summary'

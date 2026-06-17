/**
 * Payload of the `analytics://api_server_request` Tauri event emitted by the
 * Rust Local API Server proxy. The `AnalyticProvider` listens for this event
 * and forwards it to PostHog as `api_server_request`. The chat UI emits
 * `chat_request_sent` with `source: 'chat'` so both paths can be compared in
 * product analytics without any PII.
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

/**
 * Payload of the `analytics://backend_resolve_failed` Tauri event emitted by
 * the `llamacpp-upstream` extension when it cannot resolve a llama.cpp backend
 * build from the ggml-org GitHub release stream (ATO-199 / GitHub #56). The
 * `AnalyticProvider` forwards it to PostHog as `backend_resolve_failed` so the
 * blast radius of the unauthenticated `api.github.com` rate-limit dead-end is
 * visible in analytics. Zero-PII by construction.
 */
export type BackendResolveFailedEvent = {
  reason:
    | 'rate_limited'
    | 'http_error'
    | 'timeout'
    | 'offline'
    | 'parse_error'
    | 'asset_missing'
  status: number | null
  os: string
  arch: string
  fallback_used: boolean
}

export const BACKEND_RESOLVE_FAILED_EVENT = 'analytics://backend_resolve_failed'

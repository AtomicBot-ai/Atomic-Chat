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
    | 'messages'
    | 'completions'
    | 'embeddings'
    | 'messages/count_tokens'
    | 'models'
    | 'other'
  method: 'GET' | 'POST'
  model_id: string | null
  backend: 'llamacpp' | 'mlx' | 'remote' | 'unknown'
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
    | 'upstream'
    | null
}

export const API_SERVER_REQUEST_EVENT = 'analytics://api_server_request'

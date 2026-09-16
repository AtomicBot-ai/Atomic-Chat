/**
 * Media contract v2 — providers, requests, jobs and the adapter interface.
 *
 * Pure types. No I/O, no React. Materialisation is deliberately *not* on the
 * adapter: `MediaOutputRef` has exactly three variants and the handling is
 * identical for every provider, so it belongs to a single service one layer up.
 */

import type { MediaCapabilities } from './models'
import type { MediaTaskId } from './tasks'

export type MediaProviderKind =
  | 'local_worker'
  | 'local_comfy'
  | 'remote_http'
  /** The engine Radium installs and runs itself (Task 30). */
  | 'local_engine'

export type MediaProviderAdapterId =
  | 'builtin-engine'
  | 'atomic-media-worker'
  | 'comfyui'
  | 'openai-images'
  | 'custom-http'

export type MediaProviderDescriptor = {
  id: string
  label: string
  kind: MediaProviderKind
  adapter: MediaProviderAdapterId
  base_url?: string
  /**
   * `setting_key` names where the secret lives in the existing settings
   * surface. The secret itself never appears here, and never in localStorage.
   */
  auth?: { type: 'none' | 'api_key' | 'bearer'; setting_key?: string }
  enabled: boolean
  origin: 'builtin' | 'registry' | 'user'
  /** Registry-supplied hints; adapters may ignore them. */
  endpoints?: Partial<
    Record<'health' | 'capabilities' | 'jobs' | 'events', string>
  >
  order?: number
}

export type MediaProviderHealth = {
  state: 'online' | 'offline' | 'checking' | 'unauthorised'
  service?: string
  version?: string
  detail_key?: string
  detail?: string
}

export type NormalizedMediaRequest = {
  /** ULID. Idempotency key and local correlation handle. */
  client_job_id: string
  provider_id: string
  /** Provider-qualified model id. */
  model_id: string
  task: MediaTaskId
  /** Already validated against the model's `MediaParamSpec[]`. */
  params: Record<string, unknown>
  device?: string
}

export type MediaJobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type MediaOutputRef =
  | { kind: 'local_path'; path: string; mime?: string }
  | { kind: 'url'; url: string; mime?: string; expires_at?: number }
  | { kind: 'inline'; base64: string; mime: string }

export type MediaJobError = {
  code: string
  message: string
  retryable: boolean
}

export type MediaJobSnapshot = {
  client_job_id: string
  provider_job_id?: string
  provider_id: string
  state: MediaJobState
  /** 0..100. */
  progress?: number | null
  step?: { current: number; total: number } | null
  queue_position?: number | null
  eta_ms?: number | null
  /** Provider-native references: path, url or inline bytes. */
  outputs?: MediaOutputRef[]
  error?: MediaJobError | null
  started_at?: number
  finished_at?: number
}

/** The handle needed to poll, subscribe to or cancel a job. */
export type MediaJobHandle = Pick<
  MediaJobSnapshot,
  'client_job_id' | 'provider_job_id'
>

export interface MediaProviderAdapter {
  readonly descriptor: MediaProviderDescriptor

  health(signal?: AbortSignal): Promise<MediaProviderHealth>
  capabilities(signal?: AbortSignal): Promise<MediaCapabilities>

  submit(
    req: NormalizedMediaRequest,
    signal?: AbortSignal
  ): Promise<MediaJobSnapshot>
  poll(handle: MediaJobHandle, signal?: AbortSignal): Promise<MediaJobSnapshot>

  /** Optional. Presence must match `capabilities.features.events`. */
  subscribe?(
    handle: MediaJobHandle,
    onEvent: (snapshot: MediaJobSnapshot) => void
  ): () => void

  /** Optional. Presence must match `capabilities.features.cancel`. */
  cancel?(handle: MediaJobHandle): Promise<void>

  /** Optional. Presence must match `capabilities.features.install`. */
  install?(
    modelId: string,
    onProgress: (p: { received: number; total?: number }) => void,
    signal?: AbortSignal
  ): Promise<void>
  uninstall?(modelId: string): Promise<void>
}

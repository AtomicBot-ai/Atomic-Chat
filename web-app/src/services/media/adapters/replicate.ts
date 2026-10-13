/**
 * The Replicate adapter.
 *
 * Replicate is job-based: creating a prediction answers at once with an id and
 * a status, and the prediction is polled until it reaches a terminal one. That
 * maps onto the contract directly, so this adapter is a translation layer and
 * little else.
 *
 * ## Recorded surface
 *
 * Read 2026-10-09 from Replicate's published OpenAPI document
 * (`https://api.replicate.com/openapi.json`), the models' own schemas on
 * replicate.com, and live unauthenticated responses from the API - not from
 * memory (AGENTS.md 6.2).
 *
 * - `POST /v1/models/{owner}/{name}/predictions` `{ input }` creates a
 *   prediction. This route serves *official* models only; a community model
 *   needs a version id, which is why every model declared below is official.
 *   `Prefer: wait` is deliberately not sent: the job manager polls.
 * - `GET /v1/predictions/{id}` returns the prediction. `status` is one of
 *   `starting` (waiting for, or booting, a worker), `processing`, `succeeded`,
 *   `failed`, `canceled` or `aborted` (terminated before it started, e.g. by a
 *   deadline). `error` is a string on failure; `output` is model-specific.
 * - `POST /v1/predictions/{id}/cancel` cancels and returns the prediction.
 * - `GET /v1/account` identifies the token's owner: the health probe.
 * - `GET /v1/models/{owner}/{name}` describes a model.
 * - Errors are RFC 7807 problem details, `{ title, detail, status }`, served
 *   as `application/problem+json`; 422 adds `invalid_fields`, 429 carries
 *   `Retry-After`. A missing or bad token is a 401.
 *
 * The API sends no CORS headers, so in the app this adapter must be given the
 * Tauri HTTP client (`services/media/transport.ts`), which the factory does.
 *
 * ## The secret
 *
 * Resolved per request through the injected `resolveSecret` (the OS credential
 * store in the app), written only to the `Authorization` header, never held on
 * the adapter and never put into an error message.
 */

import { MEDIA_CONTRACT_VERSION, MEDIA_TASK } from '../contract'
import type {
  MediaCapabilities,
  MediaJobHandle,
  MediaJobSnapshot,
  MediaModelDescriptor,
  MediaOutputRef,
  MediaParamSpec,
  MediaProviderAdapter,
  MediaProviderDescriptor,
  MediaProviderHealth,
  NormalizedMediaRequest,
} from '../contract'
import {
  MEDIA_HTTP_TIMEOUT_MS,
  MediaHttpError,
  baseUrlOf,
  codeForStatus,
  describeFailure,
  globalTransport,
  isDataUrl,
  isRecord,
  isRetryableStatus,
  localModelId,
  mimeFromName,
  readJson,
  redactCredentials,
  resolveCredential,
  retryAfterMs,
  signalWithDeadline,
  snapshotFor,
  type MediaHttpAdapterOptions,
} from './http'
import { PROMPT, SEED } from './sharedParams'

export class ReplicateError extends MediaHttpError {
  constructor(
    message: string,
    code: string,
    status?: number,
    retryable = false,
    retryAfter?: number
  ) {
    super(message, code, status, retryable, retryAfter)
    this.name = 'ReplicateError'
  }
}

export type ReplicateAdapterOptions = MediaHttpAdapterOptions

export const REPLICATE_DEFAULT_BASE_URL = 'https://api.replicate.com/v1'

// --- wire types --------------------------------------------------------------

type ReplicateStatus =
  | 'starting'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'aborted'

type ReplicatePrediction = {
  id: string
  model?: string
  version?: string
  status: ReplicateStatus
  input?: Record<string, unknown>
  output?: unknown
  error?: string | null
  logs?: string | null
  created_at?: string | null
  started_at?: string | null
  completed_at?: string | null
  urls?: { get?: string; cancel?: string; web?: string; stream?: string }
}

type ReplicateProblem = {
  title?: string
  detail?: string
  status?: number
  invalid_fields?: Array<{ field?: string; description?: string }>
}

// --- declared models ---------------------------------------------------------

/**
 * Declared from each model's published input schema. Ids are Replicate's own
 * input names, so a validated params bag *is* the prediction input.
 */
function declaredModels(providerId: string): MediaModelDescriptor[] {
  const fluxSchnell: MediaParamSpec[] = [
    PROMPT,
    {
      id: 'aspect_ratio',
      type: 'enum',
      label: 'Aspect ratio',
      group: 'output',
      order: 1,
      options: [
        '1:1',
        '16:9',
        '21:9',
        '3:2',
        '2:3',
        '4:5',
        '5:4',
        '3:4',
        '4:3',
        '9:16',
        '9:21',
      ].map((value) => ({ value })),
      default: '1:1',
    },
    {
      id: 'num_outputs',
      type: 'int',
      label: 'Images',
      group: 'output',
      order: 2,
      min: 1,
      max: 4,
      default: 1,
    },
    {
      id: 'output_format',
      type: 'enum',
      label: 'File format',
      group: 'output',
      order: 3,
      options: ['webp', 'jpg', 'png'].map((value) => ({ value })),
      default: 'webp',
    },
    {
      id: 'output_quality',
      type: 'int',
      label: 'Quality',
      group: 'output',
      order: 4,
      min: 0,
      max: 100,
      default: 80,
      advanced: true,
      depends_on: [{ param: 'output_format', in: ['webp', 'jpg'] }],
    },
    {
      id: 'megapixels',
      type: 'enum',
      label: 'Megapixels',
      group: 'output',
      order: 5,
      options: [
        { value: '1', label: '1 MP' },
        { value: '0.25', label: '0.25 MP' },
      ],
      default: '1',
      advanced: true,
    },
    {
      id: 'num_inference_steps',
      type: 'int',
      label: 'Steps',
      group: 'sampling',
      order: 1,
      min: 1,
      max: 4,
      default: 4,
      advanced: true,
    },
    {
      id: 'go_fast',
      type: 'bool',
      label: 'Fast mode (fp8)',
      help: 'Faster, but not deterministic even with a fixed seed.',
      group: 'sampling',
      order: 2,
      default: true,
      advanced: true,
    },
    SEED,
  ]

  const video01: MediaParamSpec[] = [
    PROMPT,
    {
      id: 'first_frame_image',
      type: 'image_ref',
      label: 'First frame',
      help: 'Optional: the picture the video starts from. Sets its aspect ratio.',
      group: 'core',
      order: 2,
      accept: ['image/png', 'image/jpeg', 'image/webp'],
    },
    {
      id: 'prompt_optimizer',
      type: 'bool',
      label: 'Optimise prompt',
      group: 'advanced',
      order: 1,
      default: true,
      advanced: true,
    },
  ]

  return [
    {
      id: `${providerId}:black-forest-labs/flux-schnell`,
      provider_id: providerId,
      local_id: 'black-forest-labs/flux-schnell',
      label: 'FLUX.1 [schnell]',
      family: 'flux',
      tasks: [MEDIA_TASK.TEXT_TO_IMAGE],
      params: { [MEDIA_TASK.TEXT_TO_IMAGE]: fluxSchnell },
      outputs: { [MEDIA_TASK.TEXT_TO_IMAGE]: { media_type: 'image' } },
      install: { installed: true, installable: false },
      cost: { unit: 'usd' },
    },
    {
      id: `${providerId}:minimax/video-01`,
      provider_id: providerId,
      local_id: 'minimax/video-01',
      label: 'MiniMax Video-01',
      tasks: [MEDIA_TASK.TEXT_TO_VIDEO],
      params: { [MEDIA_TASK.TEXT_TO_VIDEO]: video01 },
      outputs: { [MEDIA_TASK.TEXT_TO_VIDEO]: { media_type: 'video' } },
      install: { installed: true, installable: false },
      cost: { unit: 'usd' },
    },
  ]
}

// --- mapping helpers ---------------------------------------------------------

/** Replicate status to contract state. `starting` is queued, not running. */
function stateOf(status: ReplicateStatus): MediaJobSnapshot['state'] {
  switch (status) {
    case 'starting':
      return 'queued'
    case 'processing':
      return 'running'
    case 'succeeded':
      return 'succeeded'
    case 'canceled':
      return 'cancelled'
    case 'failed':
    case 'aborted':
    default:
      return 'failed'
  }
}

/** Every URL in a model's output, whatever its shape (string, array, map). */
function urlsIn(output: unknown, into: string[] = []): string[] {
  if (typeof output === 'string') {
    if (/^https?:\/\//.test(output)) into.push(output)
  } else if (Array.isArray(output)) {
    for (const item of output) urlsIn(item, into)
  } else if (isRecord(output)) {
    for (const value of Object.values(output)) urlsIn(value, into)
  }
  return into
}

/** The last tqdm percentage in the logs, when the model prints one. */
function progressFromLogs(logs: string | null | undefined): number | null {
  if (!logs) return null
  const matches = [...logs.matchAll(/(\d{1,3})%\|/g)]
  const last = matches.at(-1)?.[1]
  if (last === undefined) return null
  const value = Number(last)
  return Number.isFinite(value) ? Math.min(100, value) : null
}

function epochMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function isPrediction(value: unknown): value is ReplicatePrediction {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.status === 'string'
  )
}

export function createReplicateAdapter(
  descriptor: MediaProviderDescriptor,
  options: ReplicateAdapterOptions = {}
): MediaProviderAdapter {
  const base = baseUrlOf(descriptor, REPLICATE_DEFAULT_BASE_URL)
  const transport = options.fetch ?? globalTransport

  async function headers(json = false): Promise<Record<string, string>> {
    const secret = await resolveCredential(descriptor, options.resolveSecret)
    return {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    }
  }

  /** A problem-details response as an error carrying Replicate's words. */
  async function errorFor(
    response: Response,
    sent: Record<string, string>
  ): Promise<ReplicateError> {
    const problem = (await readJson(response)) as ReplicateProblem | undefined
    const fields = (problem?.invalid_fields ?? [])
      .map((field) => field.description)
      .filter((text): text is string => typeof text === 'string')
    const message =
      [problem?.detail ?? problem?.title, ...fields]
        .filter(Boolean)
        .join(' ') || `Replicate answered ${response.status}.`
    return new ReplicateError(
      redactCredentials(message, sent),
      codeForStatus(response.status),
      response.status,
      isRetryableStatus(response.status),
      retryAfterMs(response.headers?.get('retry-after'))
    )
  }

  async function prediction(response: Response): Promise<ReplicatePrediction> {
    const payload = await readJson(response)
    if (!isPrediction(payload)) {
      throw new ReplicateError(
        'Replicate answered with something that is not a prediction.',
        'invalid_response',
        response.status,
        true
      )
    }
    return payload
  }

  function snapshotOf(
    handle: MediaJobHandle,
    payload: ReplicatePrediction
  ): MediaJobSnapshot {
    const state = stateOf(payload.status)
    const timing = {
      ...(epochMs(payload.started_at) !== undefined
        ? { started_at: epochMs(payload.started_at) }
        : {}),
      ...(epochMs(payload.completed_at) !== undefined
        ? { finished_at: epochMs(payload.completed_at) }
        : {}),
    }

    if (state === 'succeeded') {
      const outputs: MediaOutputRef[] = urlsIn(payload.output).map((url) => {
        const mime = mimeFromName(url)
        return { kind: 'url', url, ...(mime ? { mime } : {}) }
      })
      if (outputs.length === 0) {
        return snapshotFor(descriptor, handle, payload.id, 'failed', {
          ...timing,
          error: {
            code: 'empty_response',
            message: 'Replicate reported success but returned no output file.',
            retryable: true,
          },
        })
      }
      return snapshotFor(descriptor, handle, payload.id, 'succeeded', {
        ...timing,
        progress: 100,
        outputs,
      })
    }

    if (state === 'failed') {
      const aborted = payload.status === 'aborted'
      return snapshotFor(descriptor, handle, payload.id, 'failed', {
        ...timing,
        error: aborted
          ? {
              code: 'aborted',
              message:
                payload.error ||
                'Replicate stopped the prediction before it started running.',
              retryable: true,
            }
          : {
              code: 'generation_failed',
              message:
                payload.error || 'Replicate reported the prediction failed.',
              // The model ran and rejected this input. The same input would
              // fail the same way.
              retryable: false,
            },
      })
    }

    return snapshotFor(descriptor, handle, payload.id, state, {
      ...timing,
      progress: state === 'running' ? progressFromLogs(payload.logs) : null,
    })
  }

  function predictionId(handle: MediaJobHandle): string {
    if (!handle.provider_job_id) {
      throw new ReplicateError(
        `Client job "${handle.client_job_id}" has no Replicate prediction id.`,
        'unknown_job'
      )
    }
    return encodeURIComponent(handle.provider_job_id)
  }

  return {
    descriptor,

    async health(signal?: AbortSignal): Promise<MediaProviderHealth> {
      try {
        const auth = await headers()
        const response = await transport(`${base}/account`, {
          headers: auth,
          signal: signalWithDeadline(signal, MEDIA_HTTP_TIMEOUT_MS.metadata),
        })
        if (response.status === 401 || response.status === 403) {
          return {
            state: 'unauthorised',
            detail: (await errorFor(response, auth)).message,
          }
        }
        if (!response.ok) {
          return {
            state: 'offline',
            detail: (await errorFor(response, auth)).message,
          }
        }
        return { state: 'online', service: 'Replicate' }
      } catch (error) {
        if (error instanceof MediaHttpError && error.code === 'no_api_key') {
          return { state: 'unauthorised', detail: error.message }
        }
        return { state: 'offline', detail: describeFailure(error) }
      }
    },

    async capabilities(signal?: AbortSignal): Promise<MediaCapabilities> {
      let models = declaredModels(descriptor.id)

      // Each declared model is looked up so that one Replicate has retired
      // (404) is not offered. Any other answer, or no answer, leaves the
      // declared list alone: capabilities are static, and reachability is
      // what `health` reports.
      try {
        const auth = await headers()
        const retired = await Promise.all(
          models.map(async (model) => {
            const response = await transport(
              `${base}/models/${model.local_id}`,
              {
                headers: auth,
                signal: signalWithDeadline(
                  signal,
                  MEDIA_HTTP_TIMEOUT_MS.metadata
                ),
              }
            )
            return response.status === 404
          })
        )
        models = models.filter((_, index) => !retired[index])
      } catch {
        // Unreachable, unauthorised or aborted: the declared list stands.
      }

      return {
        contract_version: MEDIA_CONTRACT_VERSION,
        provider_id: descriptor.id,
        devices: [],
        models,
        tasks: [
          {
            id: MEDIA_TASK.TEXT_TO_IMAGE,
            label_key: `media:task.${MEDIA_TASK.TEXT_TO_IMAGE}`,
            output_media_type: 'image',
          },
          {
            id: MEDIA_TASK.TEXT_TO_VIDEO,
            label_key: `media:task.${MEDIA_TASK.TEXT_TO_VIDEO}`,
            output_media_type: 'video',
          },
        ],
        features: {
          cancel: true,
          events: false,
          // Only when a model prints a tqdm bar; null otherwise.
          progress: true,
          queue: true,
          install: false,
          batch: true,
          synchronous: false,
        },
      }
    },

    async submit(
      req: NormalizedMediaRequest,
      signal?: AbortSignal
    ): Promise<MediaJobSnapshot> {
      const input: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(req.params)) {
        if (value === undefined || value === null || value === '') continue
        input[key] = value
      }
      // Replicate takes files as HTTP or data URLs. A local path would be sent
      // as a meaningless string and fail inside the model, so it is refused
      // here with a message that says why.
      if (
        typeof input.first_frame_image === 'string' &&
        !isDataUrl(input.first_frame_image) &&
        !/^https?:\/\//.test(input.first_frame_image)
      ) {
        throw new ReplicateError(
          'Replicate needs the first frame as an image file, not a path.',
          'invalid_params'
        )
      }

      const localId = localModelId(descriptor, req.model_id)
      const auth = await headers(true)
      const response = await transport(
        `${base}/models/${localId}/predictions`,
        {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ input }),
          signal: signalWithDeadline(signal, MEDIA_HTTP_TIMEOUT_MS.metadata),
        }
      )
      if (!response.ok) throw await errorFor(response, auth)

      const payload = await prediction(response)
      const snapshot = snapshotOf({ client_job_id: req.client_job_id }, payload)
      // Without `Prefer: wait` a fresh prediction is `starting`; the contract
      // requires submit to return a live state, so a prediction that somehow
      // finished already is reported as running and settled by the next poll.
      return snapshot.state === 'queued' || snapshot.state === 'running'
        ? snapshot
        : { ...snapshot, state: 'running', outputs: [], error: null }
    },

    async poll(
      handle: MediaJobHandle,
      signal?: AbortSignal
    ): Promise<MediaJobSnapshot> {
      const id = predictionId(handle)
      const auth = await headers()
      const response = await transport(`${base}/predictions/${id}`, {
        headers: auth,
        signal: signalWithDeadline(signal, MEDIA_HTTP_TIMEOUT_MS.metadata),
      })
      if (!response.ok) throw await errorFor(response, auth)
      return snapshotOf(handle, await prediction(response))
    },

    async cancel(handle: MediaJobHandle): Promise<void> {
      // Thrown, never a quiet return: the job manager marks the job cancelled
      // when this resolves, and must not do so while it is still running.
      const id = predictionId(handle)
      const auth = await headers()
      const response = await transport(`${base}/predictions/${id}/cancel`, {
        method: 'POST',
        headers: auth,
        signal: signalWithDeadline(undefined, MEDIA_HTTP_TIMEOUT_MS.metadata),
      })
      if (!response.ok) throw await errorFor(response, auth)
    },
  }
}

/**
 * The fal.ai adapter, over fal's queue API.
 *
 * fal is job-based. A submit is queued and answers at once with a request id
 * and the URLs to query, cancel and fetch it; the status is polled until
 * `COMPLETED`, and the result is then fetched separately. `COMPLETED` does not
 * mean succeeded - a failed request completes too, with an `error`.
 *
 * ## Recorded surface
 *
 * Read 2026-10-09 from fal's documentation (`/docs/documentation/model-apis/
 * inference/queue`, `.../model-apis/errors`, `.../model-apis/request-errors`,
 * `/docs/api-reference/platform-apis/...`), the models' OpenAPI schemas served
 * by `GET https://api.fal.ai/v1/models?expand=openapi-3.0`, and live
 * unauthenticated responses - not from memory (AGENTS.md 6.2).
 *
 * - `POST https://queue.fal.run/{model_id}` with the model input as the JSON
 *   body and `Authorization: Key <key>` returns `{ request_id, response_url,
 *   status_url, cancel_url, queue_position }`.
 * - `GET {status_url}` returns `{ status: IN_QUEUE | IN_PROGRESS | COMPLETED,
 *   request_id, queue_position?, logs?, metrics?, error?, error_type? }`.
 *   `queue_position` is the number of requests ahead; `error` and `error_type`
 *   appear only on a failed `COMPLETED`.
 * - `GET {response_url}` returns the model's output: `{ images: [{ url, width,
 *   height, content_type }] }` for FLUX, `{ video: { url, content_type,
 *   file_name, file_size } }` for Wan.
 * - `PUT {cancel_url}` answers 202 `{ status: CANCELLATION_REQUESTED }`, 400
 *   `{ status: ALREADY_COMPLETED }` or 404 `{ status: NOT_FOUND }`.
 * - Model errors are `{ detail: [{ loc, msg, type, url, ctx? }] }`; request
 *   errors are `{ detail: string, error_type }`; a bad key is a 401
 *   `{ detail: "invalid key credentials" }`.
 * - `GET https://api.fal.ai/v1/models/requests/by-endpoint` requires a key
 *   (401 `{ error: { type: authorization_error, message } }` without one): the
 *   health probe. `GET https://api.fal.ai/v1/models?endpoint_id=...` needs no
 *   key and reports each model's `status` (`active` or `deprecated`).
 *
 * ## Which URLs the key is sent to
 *
 * Only the configured base URL's origin, plus fal's own Platform API when the
 * base URL is fal's. The status, result and cancel URLs fal returns are
 * followed only when they are on the configured origin; otherwise they are
 * derived from it. A response must never be able to steer the key elsewhere,
 * and a user who points this at a gateway expects every request to go there.
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
  isRecord,
  isRetryableStatus,
  localModelId,
  mimeFromName,
  readJson,
  redactCredentials,
  resolveCredential,
  retryAfterMs,
  sameOrigin,
  signalWithDeadline,
  snapshotFor,
  type MediaHttpAdapterOptions,
} from './http'
import { PROMPT, SEED } from './sharedParams'

export class FalAiError extends MediaHttpError {
  constructor(
    message: string,
    code: string,
    status?: number,
    retryable = false,
    retryAfter?: number
  ) {
    super(message, code, status, retryable, retryAfter)
    this.name = 'FalAiError'
  }
}

export type FalAiAdapterOptions = MediaHttpAdapterOptions

export const FAL_QUEUE_BASE_URL = 'https://queue.fal.run'
export const FAL_PLATFORM_BASE_URL = 'https://api.fal.ai/v1'

// --- wire types --------------------------------------------------------------

type FalQueueStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED'

type FalSubmitResponse = {
  request_id: string
  response_url?: string
  status_url?: string
  cancel_url?: string
  queue_position?: number
}

type FalStatusResponse = {
  status: FalQueueStatus
  request_id?: string
  queue_position?: number
  response_url?: string
  logs?: Array<{ message?: string }> | null
  metrics?: { inference_time?: number } | null
  error?: string | null
  error_type?: string | null
}

type FalFile = {
  url: string
  content_type?: string | null
  file_name?: string | null
  file_size?: number | null
}

/** Request errors whose cause is transient (fal's own guidance). */
const TRANSIENT_ERROR_TYPES = new Set([
  'request_timeout',
  'startup_timeout',
  'runner_scheduling_failure',
  'runner_connection_timeout',
  'runner_disconnected',
  'runner_connection_refused',
  'runner_connection_error',
  'runner_incomplete_response',
  'internal_error',
])

// --- declared models ---------------------------------------------------------

/**
 * fal's Wan 2.2 A14B frame window. `length_seconds` is translated into a
 * `num_frames` inside this window at the chosen `frames_per_second`.
 */
const FAL_WAN_MIN_FRAMES = 17
const FAL_WAN_MAX_FRAMES = 161
const FAL_WAN_DEFAULT_FPS = 16

/**
 * Durations the length picker offers, in seconds. Each is reachable at the
 * default 16 fps inside fal's 17–161 frame window (10 s × 16 = 160 ≤ 161).
 * Longer clips run at a lower fps, which the `frames_per_second` control
 * still lets a power user trade off.
 */
const FAL_WAN_LENGTH_SECONDS = [1, 2, 3, 4, 5, 8, 10] as const

/**
 * Translate the canonical `length_seconds` (and optional `fps`) — the keys the
 * built-in engine, the chat popup and the shared contract speak — into fal's
 * native `num_frames` + `frames_per_second`. A caller that already set fal's
 * native keys is left untouched. This is the cloud half of the one-length-
 * choice-works-everywhere abstraction; the local half lives in
 * `builtinEngine.ts`.
 */
function translateVideoLength(input: Record<string, unknown>): void {
  if (typeof input.fps === 'number' && input.frames_per_second === undefined) {
    input.frames_per_second = input.fps
  }
  delete input.fps

  const seconds = Number(input.length_seconds)
  if (input.num_frames === undefined && Number.isFinite(seconds) && seconds > 0) {
    const fps =
      typeof input.frames_per_second === 'number'
        ? input.frames_per_second
        : FAL_WAN_DEFAULT_FPS
    input.num_frames = Math.min(
      FAL_WAN_MAX_FRAMES,
      Math.max(FAL_WAN_MIN_FRAMES, Math.round(seconds * fps))
    )
    if (input.frames_per_second === undefined) input.frames_per_second = fps
  }
  delete input.length_seconds
}

/** Declared from each model's OpenAPI input schema; ids are fal's own. */
function declaredModels(providerId: string): MediaModelDescriptor[] {
  const fluxSchnell: MediaParamSpec[] = [
    PROMPT,
    {
      id: 'image_size',
      type: 'enum',
      label: 'Size',
      group: 'output',
      order: 1,
      options: [
        { value: 'square_hd', label: 'Square HD' },
        { value: 'square', label: 'Square' },
        { value: 'portrait_4_3', label: 'Portrait 3:4' },
        { value: 'portrait_16_9', label: 'Portrait 9:16' },
        { value: 'landscape_4_3', label: 'Landscape 4:3' },
        { value: 'landscape_16_9', label: 'Landscape 16:9' },
      ],
      default: 'landscape_4_3',
    },
    {
      id: 'num_images',
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
      options: ['jpeg', 'png'].map((value) => ({ value })),
      default: 'jpeg',
    },
    {
      id: 'num_inference_steps',
      type: 'int',
      label: 'Steps',
      group: 'sampling',
      order: 1,
      min: 1,
      max: 12,
      default: 4,
      advanced: true,
    },
    {
      id: 'enable_safety_checker',
      type: 'bool',
      label: 'Safety checker',
      group: 'advanced',
      order: 1,
      default: true,
      advanced: true,
    },
    SEED,
  ]

  const wan22: MediaParamSpec[] = [
    PROMPT,
    {
      id: 'negative_prompt',
      type: 'text',
      label: 'Negative prompt',
      group: 'core',
      order: 2,
    },
    {
      id: 'aspect_ratio',
      type: 'enum',
      label: 'Aspect ratio',
      group: 'output',
      order: 1,
      options: ['16:9', '9:16', '1:1'].map((value) => ({ value })),
      default: '16:9',
    },
    {
      id: 'resolution',
      type: 'enum',
      label: 'Resolution',
      group: 'output',
      order: 2,
      options: ['480p', '580p', '720p'].map((value) => ({ value })),
      default: '720p',
    },
    {
      id: 'length_seconds',
      type: 'enum',
      label: 'Length',
      group: 'motion',
      order: 1,
      options: FAL_WAN_LENGTH_SECONDS.map((seconds) => ({
        value: seconds,
        label: seconds === 1 ? '1 second' : `${seconds} seconds`,
      })),
      default: 5,
    },
    {
      id: 'num_frames',
      type: 'int',
      label: 'Frames',
      group: 'motion',
      order: 2,
      min: FAL_WAN_MIN_FRAMES,
      max: FAL_WAN_MAX_FRAMES,
      default: 81,
      advanced: true,
    },
    {
      id: 'frames_per_second',
      type: 'int',
      label: 'Frames per second',
      group: 'motion',
      order: 3,
      min: 4,
      max: 60,
      default: FAL_WAN_DEFAULT_FPS,
      advanced: true,
    },
    {
      id: 'num_inference_steps',
      type: 'int',
      label: 'Steps',
      group: 'sampling',
      order: 1,
      min: 2,
      max: 40,
      default: 27,
      advanced: true,
    },
    {
      id: 'guidance_scale',
      type: 'float',
      label: 'Guidance',
      group: 'sampling',
      order: 2,
      min: 1,
      max: 10,
      step: 0.1,
      default: 3.5,
      advanced: true,
    },
    {
      id: 'enable_prompt_expansion',
      type: 'bool',
      label: 'Expand prompt',
      group: 'advanced',
      order: 1,
      default: false,
      advanced: true,
    },
    SEED,
  ]

  // Image-to-video: same motion/sampling knobs as text-to-video, but led by a
  // starting image instead of `negative_prompt`. fal's `image_url` accepts a
  // data URL, which is exactly what the form's image input produces, so no
  // submit-time conversion is needed.
  const wanImageInput: MediaParamSpec = {
    id: 'image_url',
    type: 'image_ref',
    label: 'Starting image',
    help: 'The picture the video starts from. Its aspect ratio is kept.',
    group: 'core',
    order: 1,
    accept: ['image/png', 'image/jpeg', 'image/webp'],
  }
  const wan22I2v: MediaParamSpec[] = [
    PROMPT,
    wanImageInput,
    ...wan22.filter((spec) => spec.id !== 'prompt'),
  ]

  return [
    {
      id: `${providerId}:fal-ai/flux/schnell`,
      provider_id: providerId,
      local_id: 'fal-ai/flux/schnell',
      label: 'FLUX.1 [schnell]',
      family: 'flux',
      tasks: [MEDIA_TASK.TEXT_TO_IMAGE],
      params: { [MEDIA_TASK.TEXT_TO_IMAGE]: fluxSchnell },
      outputs: { [MEDIA_TASK.TEXT_TO_IMAGE]: { media_type: 'image' } },
      install: { installed: true, installable: false },
      cost: { unit: 'usd' },
    },
    {
      id: `${providerId}:fal-ai/wan/v2.2-a14b/text-to-video`,
      provider_id: providerId,
      local_id: 'fal-ai/wan/v2.2-a14b/text-to-video',
      label: 'Wan 2.2 A14B',
      family: 'wan2.2',
      tasks: [MEDIA_TASK.TEXT_TO_VIDEO],
      params: { [MEDIA_TASK.TEXT_TO_VIDEO]: wan22 },
      outputs: { [MEDIA_TASK.TEXT_TO_VIDEO]: { media_type: 'video' } },
      install: { installed: true, installable: false },
      cost: { unit: 'usd' },
    },
    {
      id: `${providerId}:fal-ai/wan/v2.2-a14b/image-to-video`,
      provider_id: providerId,
      local_id: 'fal-ai/wan/v2.2-a14b/image-to-video',
      label: 'Wan 2.2 A14B (image to video)',
      family: 'wan2.2',
      tasks: [MEDIA_TASK.TEXT_TO_VIDEO],
      params: { [MEDIA_TASK.TEXT_TO_VIDEO]: wan22I2v },
      outputs: { [MEDIA_TASK.TEXT_TO_VIDEO]: { media_type: 'video' } },
      install: { installed: true, installable: false },
      cost: { unit: 'usd' },
    },
  ]
}

// --- mapping helpers ---------------------------------------------------------

/** fal's `detail`, which is a string or an array of typed error objects. */
function detailMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const detail = payload.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const messages = detail
      .map((entry) => (isRecord(entry) ? entry.msg : undefined))
      .filter((text): text is string => typeof text === 'string')
    if (messages.length) return messages.join(' ')
  }
  // The Platform API's envelope.
  if (isRecord(payload.error) && typeof payload.error.message === 'string') {
    return payload.error.message
  }
  return undefined
}

/** The first machine-readable `type` in a model error, if there is one. */
function detailType(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  if (typeof payload.error_type === 'string') return payload.error_type
  if (Array.isArray(payload.detail)) {
    const first = payload.detail.find(isRecord)
    if (first && typeof first.type === 'string') return first.type
  }
  return undefined
}

function isFile(value: unknown): value is FalFile {
  return isRecord(value) && typeof value.url === 'string'
}

/**
 * The media files in a result, whatever the model calls them: `images` for
 * FLUX, `video` for Wan, `audio` or `image` for others. Anything with a `url`
 * at the top level, or in a top-level array, is a file.
 */
function outputsOf(result: unknown): MediaOutputRef[] {
  if (!isRecord(result)) return []
  const files: FalFile[] = []
  for (const value of Object.values(result)) {
    if (isFile(value)) files.push(value)
    else if (Array.isArray(value)) files.push(...value.filter(isFile))
  }
  return files.map((file) => {
    const mime =
      file.content_type ??
      mimeFromName(file.file_name ?? undefined) ??
      mimeFromName(file.url)
    return { kind: 'url', url: file.url, ...(mime ? { mime } : {}) }
  })
}

/** What an in-flight request needs to be queried, cancelled and collected. */
type FalRequest = {
  requestId: string
  statusUrl: string
  responseUrl: string
  cancelUrl: string
}

export function createFalAiAdapter(
  descriptor: MediaProviderDescriptor,
  options: FalAiAdapterOptions = {}
): MediaProviderAdapter {
  const base = baseUrlOf(descriptor, FAL_QUEUE_BASE_URL)
  const transport = options.fetch ?? globalTransport
  const isFalHosted = sameOrigin(base, FAL_QUEUE_BASE_URL)
  /**
   * Per client job. The job manager keeps one adapter per job for its whole
   * life, so this outlives every poll; it does not survive a restart, and
   * neither does the job manager's own state.
   */
  const requests = new Map<string, FalRequest>()

  async function headers(json = false): Promise<Record<string, string>> {
    const secret = await resolveCredential(descriptor, options.resolveSecret)
    return {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(secret ? { Authorization: `Key ${secret}` } : {}),
    }
  }

  async function errorFor(
    response: Response,
    sent: Record<string, string>
  ): Promise<FalAiError> {
    const payload = await readJson(response)
    const type = detailType(payload)
    const needsRetry = response.headers?.get('x-fal-needs-retry')
    return new FalAiError(
      redactCredentials(
        detailMessage(payload) ?? `fal.ai answered ${response.status}.`,
        sent
      ),
      type ?? codeForStatus(response.status),
      response.status,
      // fal's own retry hint wins over the status code when it is present.
      needsRetry != null
        ? /^(1|true|yes)$/i.test(needsRetry)
        : isRetryableStatus(response.status),
      retryAfterMs(response.headers?.get('retry-after'))
    )
  }

  /** A URL fal returned, if it is on the configured origin; else derived. */
  function trusted(url: string | undefined, derived: string): string {
    return url && sameOrigin(url, base) ? url : derived
  }

  function requestFor(handle: MediaJobHandle): FalRequest {
    const request = requests.get(handle.client_job_id)
    if (!request) {
      throw new FalAiError(
        `No fal.ai request is known for client job "${handle.client_job_id}".`,
        'unknown_job'
      )
    }
    return request
  }

  async function collect(
    handle: MediaJobHandle,
    request: FalRequest,
    status: FalStatusResponse,
    signal: AbortSignal | undefined
  ): Promise<MediaJobSnapshot> {
    const timing = { finished_at: Date.now() }
    if (status.error || status.error_type) {
      const type = status.error_type ?? 'generation_failed'
      return snapshotFor(descriptor, handle, request.requestId, 'failed', {
        ...timing,
        error: {
          code: type,
          message:
            status.error || `fal.ai reported the request failed (${type}).`,
          retryable: TRANSIENT_ERROR_TYPES.has(type),
        },
      })
    }

    const auth = await headers()
    const response = await transport(request.responseUrl, {
      headers: auth,
      signal: signalWithDeadline(signal, MEDIA_HTTP_TIMEOUT_MS.metadata),
    })
    if (!response.ok) {
      // A failed request's result is its error. A 5xx here is the result
      // endpoint itself failing, which polling again may get past.
      const error = await errorFor(response, auth)
      if (response.status >= 500) throw error
      return snapshotFor(descriptor, handle, request.requestId, 'failed', {
        ...timing,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
      })
    }

    const outputs = outputsOf(await readJson(response))
    if (outputs.length === 0) {
      return snapshotFor(descriptor, handle, request.requestId, 'failed', {
        ...timing,
        error: {
          code: 'empty_response',
          message: 'fal.ai completed the request but returned no file.',
          retryable: true,
        },
      })
    }
    return snapshotFor(descriptor, handle, request.requestId, 'succeeded', {
      ...timing,
      progress: 100,
      outputs,
    })
  }

  return {
    descriptor,

    async health(signal?: AbortSignal): Promise<MediaProviderHealth> {
      try {
        const auth = await headers()
        // fal's Platform API is the one place a key can be checked without
        // running a model. A gateway has no equivalent, so for one the probe
        // only establishes that it answers; the key is checked on submit.
        const url = isFalHosted
          ? `${FAL_PLATFORM_BASE_URL}/models/requests/by-endpoint?endpoint_id=${encodeURIComponent('fal-ai/flux/schnell')}&limit=1`
          : `${base}/`
        const response = await transport(url, {
          headers: isFalHosted ? auth : {},
          signal: signalWithDeadline(signal, MEDIA_HTTP_TIMEOUT_MS.metadata),
        })
        if (!isFalHosted) {
          return {
            state: 'online',
            service: 'fal.ai',
            detail: 'Reachable. The key is checked when a job is submitted.',
          }
        }
        if (response.status === 401) {
          return {
            state: 'unauthorised',
            detail: (await errorFor(response, auth)).message,
          }
        }
        if (response.status === 403) {
          // Authenticated, but the key's preset cannot read request history.
          // It can still run models, so this is not a credential failure.
          return {
            state: 'online',
            service: 'fal.ai',
            detail: (await errorFor(response, auth)).message,
          }
        }
        if (!response.ok) {
          return {
            state: 'offline',
            detail: (await errorFor(response, auth)).message,
          }
        }
        return { state: 'online', service: 'fal.ai' }
      } catch (error) {
        if (error instanceof MediaHttpError && error.code === 'no_api_key') {
          return { state: 'unauthorised', detail: error.message }
        }
        return { state: 'offline', detail: describeFailure(error) }
      }
    },

    async capabilities(signal?: AbortSignal): Promise<MediaCapabilities> {
      let models = declaredModels(descriptor.id)

      // Model metadata needs no key, so none is sent - this request goes to
      // fal even when the base URL is a gateway. A model fal has deprecated is
      // still offered, but says so; one it no longer lists is dropped.
      try {
        const query = models
          .map((model) => `endpoint_id=${encodeURIComponent(model.local_id)}`)
          .join('&')
        const response = await transport(
          `${FAL_PLATFORM_BASE_URL}/models?${query}`,
          {
            signal: signalWithDeadline(signal, MEDIA_HTTP_TIMEOUT_MS.metadata),
          }
        )
        const payload = response.ok ? await readJson(response) : undefined
        const listed =
          isRecord(payload) && Array.isArray(payload.models)
            ? payload.models
            : undefined
        if (listed) {
          const status = new Map<string, unknown>()
          for (const entry of listed) {
            if (isRecord(entry) && typeof entry.endpoint_id === 'string') {
              status.set(
                entry.endpoint_id,
                isRecord(entry.metadata) ? entry.metadata.status : undefined
              )
            }
          }
          models = models
            .filter((model) => status.has(model.local_id))
            .map((model) =>
              status.get(model.local_id) === 'deprecated'
                ? { ...model, label: `${model.label} (deprecated)` }
                : model
            )
        }
      } catch {
        // Unreachable or aborted: the declared list stands.
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
          progress: false,
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
      if (req.task === MEDIA_TASK.TEXT_TO_VIDEO) translateVideoLength(input)

      const localId = localModelId(descriptor, req.model_id)
      const auth = await headers(true)
      const response = await transport(`${base}/${localId}`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(input),
        signal: signalWithDeadline(signal, MEDIA_HTTP_TIMEOUT_MS.metadata),
      })
      if (!response.ok) throw await errorFor(response, auth)

      const payload = (await readJson(response)) as
        | FalSubmitResponse
        | undefined
      if (!payload || typeof payload.request_id !== 'string') {
        throw new FalAiError(
          'fal.ai accepted the request but returned no request id.',
          'invalid_response',
          response.status,
          true
        )
      }

      const requestId = payload.request_id
      const derived = `${base}/${localId}/requests/${encodeURIComponent(requestId)}`
      requests.set(req.client_job_id, {
        requestId,
        statusUrl: trusted(payload.status_url, `${derived}/status`),
        responseUrl: trusted(payload.response_url, derived),
        cancelUrl: trusted(payload.cancel_url, `${derived}/cancel`),
      })

      return snapshotFor(
        descriptor,
        { client_job_id: req.client_job_id },
        requestId,
        'queued',
        {
          queue_position:
            typeof payload.queue_position === 'number'
              ? payload.queue_position
              : null,
        }
      )
    },

    async poll(
      handle: MediaJobHandle,
      signal?: AbortSignal
    ): Promise<MediaJobSnapshot> {
      const request = requestFor(handle)
      const auth = await headers()
      const response = await transport(request.statusUrl, {
        headers: auth,
        signal: signalWithDeadline(signal, MEDIA_HTTP_TIMEOUT_MS.metadata),
      })
      if (!response.ok) throw await errorFor(response, auth)

      const status = (await readJson(response)) as FalStatusResponse | undefined
      switch (status?.status) {
        case 'IN_QUEUE':
          return snapshotFor(descriptor, handle, request.requestId, 'queued', {
            queue_position:
              typeof status.queue_position === 'number'
                ? status.queue_position
                : null,
          })
        case 'IN_PROGRESS':
          return snapshotFor(descriptor, handle, request.requestId, 'running')
        case 'COMPLETED':
          return collect(handle, request, status, signal)
        default:
          throw new FalAiError(
            'fal.ai answered a status request with an unknown status.',
            'invalid_response',
            response.status,
            true
          )
      }
    },

    async cancel(handle: MediaJobHandle): Promise<void> {
      const request = requestFor(handle)
      const auth = await headers()
      const response = await transport(request.cancelUrl, {
        method: 'PUT',
        headers: auth,
        signal: signalWithDeadline(undefined, MEDIA_HTTP_TIMEOUT_MS.metadata),
      })
      // 202 is accepted. 400 ALREADY_COMPLETED means there is nothing left to
      // stop, which is what the caller wanted. Anything else is a refusal the
      // caller must see, so the job is not marked cancelled while it runs.
      if (response.status === 202 || response.ok) return
      if (response.status === 400) {
        const payload = await readJson(response)
        if (isRecord(payload) && payload.status === 'ALREADY_COMPLETED') return
        throw new FalAiError(
          detailMessage(payload) ?? 'fal.ai refused the cancellation.',
          'cancel_refused',
          400
        )
      }
      throw await errorFor(response, auth)
    },
  }
}

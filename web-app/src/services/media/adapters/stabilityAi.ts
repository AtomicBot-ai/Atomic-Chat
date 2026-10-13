/**
 * The Stability AI adapter, over the v2beta Stable Image API.
 *
 * Stability's generate endpoints are *synchronous*: the response to the POST
 * is the finished image, with no job to query afterwards. That is the same
 * shape as the OpenAI-compatible images API, and it is bridged the same way
 * (see `remoteHttp.ts`): `submit` awaits only the response headers, takes the
 * request id, and returns a live `queued` snapshot while the body is still
 * arriving; `poll` reports `running` until the body lands and then the
 * outcome, without ever reaching the network - a second request would generate,
 * and charge, a second time. `features.synchronous` declares it.
 *
 * ## Recorded surface
 *
 * Read 2026-10-09 from Stability's published OpenAPI document
 * (`https://api.stability.ai/v2alpha/openapi`, the one the API reference at
 * platform.stability.ai renders) and live unauthenticated responses - not from
 * memory (AGENTS.md 6.2).
 *
 * - `POST /v2beta/stable-image/generate/{core|ultra}`, multipart/form-data,
 *   `prompt` required; `negative_prompt`, `aspect_ratio`, `seed` (0 to
 *   4294967294, 0 = random), `style_preset`, `output_format`. Ultra also takes
 *   `image` and `strength` for image-to-image.
 * - With `Accept: application/json` a 200 is `{ image: <base64>, seed,
 *   finish_reason: SUCCESS | CONTENT_FILTERED }`, with `x-request-id`,
 *   `finish-reason` and `seed` headers. CONTENT_FILTERED is still a 200.
 * - Errors are `{ id, name, errors: string[] }`: 400 bad request, 401
 *   unauthorised, 402 insufficient credit, 403 content moderation (not
 *   authentication), 413 too large, 422 invalid, 429 rate limited, 500.
 * - `GET /v1/user/balance` returns `{ credits }` and 401s without a key: the
 *   health probe. v1 errors are `{ id, name, message }`.
 *
 * In a browser `x-request-id` is not exposed (Stability sends no
 * `Access-Control-Expose-Headers`); the app uses the Tauri HTTP client, which
 * reads it. Without it the job is identified by its client job id.
 */

import { MEDIA_CONTRACT_VERSION, MEDIA_TASK } from '../contract'
import type {
  MediaCapabilities,
  MediaJobHandle,
  MediaJobSnapshot,
  MediaModelDescriptor,
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
  blobFromDataUrl,
  codeForStatus,
  describeFailure,
  globalTransport,
  isDataUrl,
  isRecord,
  isRetryableStatus,
  jobErrorFrom,
  localModelId,
  mimeFromBase64,
  readJson,
  redactCredentials,
  resolveCredential,
  retryAfterMs,
  signalWithDeadline,
  snapshotFor,
  type MediaHttpAdapterOptions,
} from './http'
import { NEGATIVE_PROMPT, PROMPT } from './sharedParams'

export class StabilityAiError extends MediaHttpError {
  constructor(
    message: string,
    code: string,
    status?: number,
    retryable = false,
    retryAfter?: number
  ) {
    super(message, code, status, retryable, retryAfter)
    this.name = 'StabilityAiError'
  }
}

export type StabilityAiAdapterOptions = MediaHttpAdapterOptions

export const STABILITY_DEFAULT_BASE_URL = 'https://api.stability.ai'

// --- wire types --------------------------------------------------------------

type StabilityImageResponse = {
  image?: string
  seed?: number
  finish_reason?: 'SUCCESS' | 'CONTENT_FILTERED' | string
}

// --- declared models ---------------------------------------------------------

const ASPECT_RATIOS = [
  '21:9',
  '16:9',
  '3:2',
  '5:4',
  '1:1',
  '4:5',
  '2:3',
  '9:16',
  '9:21',
]
const STYLE_PRESETS = [
  'enhance',
  'anime',
  'photographic',
  'digital-art',
  'comic-book',
  'fantasy-art',
  'line-art',
  'analog-film',
  'neon-punk',
  'isometric',
  'low-poly',
  'origami',
  'modeling-compound',
  'cinematic',
  '3d-model',
  'pixel-art',
  'tile-texture',
]
const MIME_BY_FORMAT: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

function textToImageParams(): MediaParamSpec[] {
  return [
    { ...PROMPT, max_length: 10_000 },
    { ...NEGATIVE_PROMPT, max_length: 10_000 },
    {
      id: 'aspect_ratio',
      type: 'enum',
      label: 'Aspect ratio',
      group: 'output',
      order: 1,
      options: ASPECT_RATIOS.map((value) => ({ value })),
      default: '1:1',
    },
    {
      id: 'output_format',
      type: 'enum',
      label: 'File format',
      group: 'output',
      order: 2,
      options: ['png', 'jpeg', 'webp'].map((value) => ({ value })),
      default: 'png',
    },
    {
      id: 'style_preset',
      type: 'enum',
      label: 'Style',
      group: 'advanced',
      order: 1,
      options: STYLE_PRESETS.map((value) => ({ value })),
      advanced: true,
    },
    {
      id: 'seed',
      type: 'seed',
      label: 'Seed',
      group: 'sampling',
      order: 1,
      // 0 means "random" to Stability; the job manager resolves a real seed
      // above every adapter (D8), so a 0 never needs to be sent on purpose.
      min: 0,
      max: 4_294_967_294,
    },
  ]
}

function declaredModels(providerId: string): MediaModelDescriptor[] {
  const ultraImageToImage: MediaParamSpec[] = [
    ...textToImageParams().filter((spec) => spec.id !== 'aspect_ratio'),
    {
      id: 'image',
      type: 'image_ref',
      label: 'Starting image',
      group: 'core',
      order: 3,
      required: true,
      accept: ['image/png', 'image/jpeg', 'image/webp'],
    },
    {
      id: 'strength',
      type: 'float',
      label: 'How much to change it',
      help: '0 keeps the starting image; 1 ignores it.',
      group: 'core',
      order: 4,
      required: true,
      min: 0,
      max: 1,
      step: 0.05,
      widget: 'slider',
    },
  ]

  return [
    {
      id: `${providerId}:core`,
      provider_id: providerId,
      local_id: 'core',
      label: 'Stable Image Core',
      tasks: [MEDIA_TASK.TEXT_TO_IMAGE],
      params: { [MEDIA_TASK.TEXT_TO_IMAGE]: textToImageParams() },
      outputs: { [MEDIA_TASK.TEXT_TO_IMAGE]: { media_type: 'image' } },
      install: { installed: true, installable: false },
      cost: { unit: 'credit' },
    },
    {
      id: `${providerId}:ultra`,
      provider_id: providerId,
      local_id: 'ultra',
      label: 'Stable Image Ultra',
      tasks: [MEDIA_TASK.TEXT_TO_IMAGE, MEDIA_TASK.IMAGE_TO_IMAGE],
      params: {
        [MEDIA_TASK.TEXT_TO_IMAGE]: textToImageParams(),
        [MEDIA_TASK.IMAGE_TO_IMAGE]: ultraImageToImage,
      },
      outputs: {
        [MEDIA_TASK.TEXT_TO_IMAGE]: { media_type: 'image' },
        [MEDIA_TASK.IMAGE_TO_IMAGE]: { media_type: 'image' },
      },
      install: { installed: true, installable: false },
      cost: { unit: 'credit' },
    },
  ]
}

/** Stability's error envelope, v2beta (`errors[]`) or v1 (`message`). */
function errorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  if (Array.isArray(payload.errors)) {
    const errors = payload.errors.filter(
      (e): e is string => typeof e === 'string'
    )
    if (errors.length) return errors.join(' ')
  }
  return typeof payload.message === 'string' ? payload.message : undefined
}

/** One generation in flight: the un-awaited body plus what it settles to. */
type Pending = {
  providerJobId: string
  outputFormat: string
  status: 'pending' | 'resolved' | 'rejected'
  payload?: StabilityImageResponse
  reason?: unknown
  settled?: MediaJobSnapshot
}

export function createStabilityAiAdapter(
  descriptor: MediaProviderDescriptor,
  options: StabilityAiAdapterOptions = {}
): MediaProviderAdapter {
  const base = baseUrlOf(descriptor, STABILITY_DEFAULT_BASE_URL)
  const transport = options.fetch ?? globalTransport
  const pending = new Map<string, Pending>()

  async function headers(): Promise<Record<string, string>> {
    const secret = await resolveCredential(descriptor, options.resolveSecret)
    return {
      Accept: 'application/json',
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    }
  }

  async function errorFor(
    response: Response,
    sent: Record<string, string>
  ): Promise<StabilityAiError> {
    const payload = await readJson(response)
    const name =
      isRecord(payload) && typeof payload.name === 'string'
        ? payload.name
        : undefined
    // 403 from a generate endpoint is content moderation, not authentication.
    const code =
      response.status === 403 && name === 'content_moderation'
        ? 'content_filtered'
        : codeForStatus(response.status)
    return new StabilityAiError(
      redactCredentials(
        errorMessage(payload) ?? `Stability AI answered ${response.status}.`,
        sent
      ),
      code,
      response.status,
      isRetryableStatus(response.status),
      retryAfterMs(response.headers?.get('retry-after'))
    )
  }

  function settle(handle: MediaJobHandle, entry: Pending): MediaJobSnapshot {
    if (entry.status === 'rejected') {
      return snapshotFor(descriptor, handle, entry.providerJobId, 'failed', {
        finished_at: Date.now(),
        error: jobErrorFrom(entry.reason),
      })
    }
    const payload = entry.payload ?? {}
    if (payload.finish_reason === 'CONTENT_FILTERED') {
      return snapshotFor(descriptor, handle, entry.providerJobId, 'failed', {
        finished_at: Date.now(),
        error: {
          code: 'content_filtered',
          message:
            'Stability AI generated an image but its content moderation withheld it.',
          retryable: false,
        },
      })
    }
    if (typeof payload.image !== 'string' || payload.image.length === 0) {
      return snapshotFor(descriptor, handle, entry.providerJobId, 'failed', {
        finished_at: Date.now(),
        error: {
          code: 'empty_response',
          message: 'Stability AI returned no image.',
          retryable: true,
        },
      })
    }
    return snapshotFor(descriptor, handle, entry.providerJobId, 'succeeded', {
      finished_at: Date.now(),
      progress: 100,
      outputs: [
        {
          kind: 'inline',
          base64: payload.image,
          mime:
            mimeFromBase64(payload.image) ??
            MIME_BY_FORMAT[entry.outputFormat] ??
            'image/png',
        },
      ],
    })
  }

  return {
    descriptor,

    async health(signal?: AbortSignal): Promise<MediaProviderHealth> {
      try {
        const auth = await headers()
        const response = await transport(`${base}/v1/user/balance`, {
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
        return { state: 'online', service: 'Stability AI' }
      } catch (error) {
        if (error instanceof MediaHttpError && error.code === 'no_api_key') {
          return { state: 'unauthorised', detail: error.message }
        }
        return { state: 'offline', detail: describeFailure(error) }
      }
    },

    async capabilities(signal?: AbortSignal): Promise<MediaCapabilities> {
      // Declared: Stability publishes no listing of its v2beta models. The
      // probe only confirms the API answers, the same as `remoteHttp`, and it
      // honours the caller's signal like every other request here. Its result
      // is deliberately unused - reachability is what `health` reports.
      try {
        await transport(`${base}/v1/user/balance`, {
          headers: await headers(),
          signal: signalWithDeadline(signal, MEDIA_HTTP_TIMEOUT_MS.metadata),
        })
      } catch {
        // Unreachable or unauthorised: the declared list stands.
      }
      const models = declaredModels(descriptor.id)

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
            id: MEDIA_TASK.IMAGE_TO_IMAGE,
            label_key: `media:task.${MEDIA_TASK.IMAGE_TO_IMAGE}`,
            output_media_type: 'image',
          },
        ],
        features: {
          // The generate endpoints have no cancel, no queue and no progress.
          cancel: false,
          events: false,
          progress: false,
          queue: false,
          install: false,
          batch: false,
          synchronous: true,
        },
      }
    },

    async submit(
      req: NormalizedMediaRequest,
      signal?: AbortSignal
    ): Promise<MediaJobSnapshot> {
      const localId = localModelId(descriptor, req.model_id)
      const form = new FormData()
      for (const [key, value] of Object.entries(req.params)) {
        if (value === undefined || value === null || value === '') continue
        if (key === 'image') {
          if (!isDataUrl(value)) {
            throw new StabilityAiError(
              'Stability AI needs the starting image as an image file, not a path.',
              'invalid_params'
            )
          }
          form.append('image', blobFromDataUrl(value), 'image')
          continue
        }
        form.append(key, String(value))
      }
      const outputFormat =
        typeof req.params.output_format === 'string'
          ? req.params.output_format
          : 'png'

      // Awaited only as far as the headers. The body - the image - is left in
      // flight so the caller gets a live job, not a finished one.
      const auth = await headers()
      const response = await transport(
        `${base}/v2beta/stable-image/generate/${encodeURIComponent(localId)}`,
        {
          method: 'POST',
          // No Content-Type: the runtime sets multipart with its boundary.
          headers: auth,
          body: form,
          signal: signalWithDeadline(signal, MEDIA_HTTP_TIMEOUT_MS.generation),
        }
      )
      if (!response.ok) throw await errorFor(response, auth)

      const providerJobId =
        response.headers?.get('x-request-id') ?? req.client_job_id
      const entry: Pending = { providerJobId, outputFormat, status: 'pending' }
      void (response.json() as Promise<StabilityImageResponse>).then(
        (payload) => {
          entry.status = 'resolved'
          entry.payload = payload
        },
        (reason: unknown) => {
          entry.status = 'rejected'
          entry.reason = reason
        }
      )
      pending.set(req.client_job_id, entry)

      return snapshotFor(
        descriptor,
        { client_job_id: req.client_job_id },
        providerJobId,
        'queued',
        { started_at: Date.now() }
      )
    },

    async poll(handle: MediaJobHandle): Promise<MediaJobSnapshot> {
      const entry = pending.get(handle.client_job_id)
      if (!entry) {
        throw new StabilityAiError(
          `No Stability AI generation is in flight for client job "${handle.client_job_id}".`,
          'unknown_job'
        )
      }
      if (entry.settled) return entry.settled

      // Never re-sends. One microtask turn lets a body that has already
      // arrived record itself before this decides the job is still running.
      await Promise.resolve()
      if (entry.status === 'pending') {
        return snapshotFor(descriptor, handle, entry.providerJobId, 'running')
      }

      entry.settled = settle(handle, entry)
      return entry.settled
    },

    // No cancel, subscribe or install: the API has none, and features.* says so.
  }
}

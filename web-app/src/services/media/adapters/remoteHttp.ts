/**
 * The remote HTTP media adapter, against the OpenAI-compatible images shape.
 *
 * The third `MediaProviderAdapter`, and the first that is *synchronous*:
 * `POST /images/generations` returns the finished image in the same response.
 * There is no job id, no queue, no progress and nothing to poll. The contract
 * is asynchronous, so this adapter's real job is bridging that gap without
 * lying about it and without the conformance suite being bent to fit.
 *
 * ## How a synchronous API satisfies an asynchronous contract
 *
 * `fetch` resolves as soon as the response **headers** arrive; the body is
 * still streaming. So `submit` awaits only that much, takes the provider-side
 * job id from the `x-request-id` header, and returns a live `queued` snapshot
 * while holding the un-awaited body promise. `poll` reports `running` until
 * that promise settles, then `succeeded` with the image.
 *
 * That is not a trick: it is what the transport actually does. The alternatives
 * were to invent a job id, or to return `succeeded` from `submit` and change
 * the contract. The first is dishonest and the second would have rippled into
 * two working adapters and the conformance suite.
 *
 * ## Recorded surface (T06-S01)
 *
 * Read 2026-09-09 from the official OpenAI Node SDK source, because the docs
 * site returns 403 to automated fetches - `src/resources/images.ts` for the
 * request and response shapes and `src/core/error.ts` for the error envelope
 * and its status mapping. Nothing here came from memory (AGENTS.md 6.2).
 *
 * - Request: `{ prompt, model, n?, size?, quality?, background?, output_format?,
 *   response_format?, style?, user?, ... }`
 * - Response: `{ created, data?: Array<{ url?, b64_json?, revised_prompt? }>,
 *   background?, output_format?, quality?, size?, usage? }` - note `data` is
 *   **optional** in the SDK's own type, so its absence is a real case.
 * - Errors: `{ error: { message, type, param, code } }`, with 401
 *   authentication, 403 permission denied and 429 rate limit.
 *
 * ## The secret
 *
 * The key is resolved through an injected `resolveSecret`, never read from a
 * descriptor and never held on this module. It is written to exactly one place,
 * the `Authorization` header, and deliberately never interpolated into an error
 * message or any string this adapter constructs - an error object is the single
 * most likely thing to reach a log line.
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
import { PROMPT } from './sharedParams'

/** Resolves a configured secret by the `setting_key` naming where it lives. */
export type MediaSecretResolver = (
  settingKey: string
) => string | undefined | Promise<string | undefined>

export type RemoteHttpAdapterOptions = {
  resolveSecret?: MediaSecretResolver
}

export class RemoteHttpError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    /** Only a transport or rate-limit failure is worth trying again. */
    readonly retryable: boolean = false
  ) {
    super(message)
    this.name = 'RemoteHttpError'
  }
}

// --- wire types --------------------------------------------------------------

type OpenAiImage = {
  url?: string
  b64_json?: string
  revised_prompt?: string
  /** Not part of OpenAI's shape; some compatible providers do send it. */
  expires_at?: number
}

type OpenAiImagesResponse = {
  created?: number
  data?: OpenAiImage[]
  output_format?: string
  size?: string
}

type OpenAiError = {
  error?: { message?: string; type?: string; param?: string; code?: string }
}

// --- declared models ---------------------------------------------------------

const SIZES = ['1024x1024', '1024x1536', '1536x1024']
const QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Declared, not discovered. `GET /models` lists chat models alongside image
 * ones and offers nothing that says which is which, so inferring an image model
 * list from it would be guesswork - the same reason ComfyUI's models come from
 * declared templates.
 */
function declaredModels(providerId: string): MediaModelDescriptor[] {
  const params: MediaParamSpec[] = [
    PROMPT,
    {
      id: 'size',
      type: 'enum',
      label: 'Size',
      group: 'output',
      order: 1,
      options: SIZES.map((value) => ({ value })),
      default: '1024x1024',
    },
    {
      id: 'quality',
      type: 'enum',
      label: 'Quality',
      group: 'output',
      order: 2,
      options: QUALITIES.map((value) => ({ value })),
      default: 'auto',
    },
    {
      id: 'background',
      type: 'enum',
      label: 'Background',
      group: 'output',
      order: 3,
      options: ['auto', 'transparent', 'opaque'].map((value) => ({ value })),
      default: 'auto',
    },
    {
      id: 'output_format',
      type: 'enum',
      label: 'File format',
      group: 'output',
      order: 4,
      options: ['png', 'jpeg', 'webp'].map((value) => ({ value })),
      default: 'png',
    },
    {
      id: 'n',
      type: 'int',
      label: 'Images',
      group: 'output',
      order: 5,
      min: 1,
      max: 10,
      default: 1,
      advanced: true,
    },
  ]

  return [
    {
      id: `${providerId}:gpt-image-1`,
      provider_id: providerId,
      local_id: 'gpt-image-1',
      label: 'GPT Image 1',
      tasks: [MEDIA_TASK.TEXT_TO_IMAGE],
      params: { [MEDIA_TASK.TEXT_TO_IMAGE]: params },
      outputs: { [MEDIA_TASK.TEXT_TO_IMAGE]: { media_type: 'image' } },
      install: { installed: true, installable: false },
      // Display only. Never used to gate a submission - the contract is explicit
      // that cost must not stop the user pressing the button.
      cost: { unit: 'usd' },
    },
  ]
}

const MIME_BY_FORMAT: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

/** `image/png` unless the payload says otherwise. */
function mimeOf(format: string | undefined, url?: string): string | undefined {
  if (format && MIME_BY_FORMAT[format]) return MIME_BY_FORMAT[format]
  const extension = url?.split('?')[0]?.split('.').pop()?.toLowerCase()
  return extension ? MIME_BY_FORMAT[extension] : undefined
}

/** One in-flight generation: the un-awaited body plus what it settles to. */
type Pending = {
  providerJobId: string
  status: 'pending' | 'resolved' | 'rejected'
  payload?: OpenAiImagesResponse
  reason?: unknown
  settled?: MediaJobSnapshot
}

export function createRemoteHttpAdapter(
  descriptor: MediaProviderDescriptor,
  options: RemoteHttpAdapterOptions = {}
): MediaProviderAdapter {
  const base = (descriptor.base_url ?? 'https://api.openai.com/v1').replace(
    /\/+$/,
    ''
  )
  const resolveSecret = options.resolveSecret
  const pending = new Map<string, Pending>()

  async function authorization(): Promise<Record<string, string>> {
    const settingKey = descriptor.auth?.setting_key
    if (!descriptor.auth || descriptor.auth.type === 'none') return {}
    if (!settingKey || !resolveSecret) {
      throw new RemoteHttpError(
        `Provider "${descriptor.label}" has no API key configured.`,
        'no_api_key'
      )
    }

    const secret = await resolveSecret(settingKey)
    if (!secret) {
      // Refused before any request is built: sending a blank Authorization
      // header would produce a confusing 401 instead of an actionable message.
      throw new RemoteHttpError(
        `Provider "${descriptor.label}" has no API key configured.`,
        'no_api_key'
      )
    }

    const scheme = descriptor.auth.type === 'api_key' ? 'Bearer' : 'Bearer'
    return { Authorization: `${scheme} ${secret}` }
  }

  /** Map a non-2xx response to an error carrying the provider's own words. */
  async function errorFor(response: Response): Promise<RemoteHttpError> {
    let payload: OpenAiError | undefined
    try {
      payload = (await response.json()) as OpenAiError
    } catch {
      payload = undefined
    }

    const retryable = response.status === 429 || response.status >= 500
    return new RemoteHttpError(
      // The provider's message only. Nothing this function builds ever includes
      // the key, the Authorization header, or the request body.
      payload?.error?.message ??
        `The provider answered ${response.status}.`,
      payload?.error?.code ?? `http_${response.status}`,
      response.status,
      retryable
    )
  }

  function outputsOf(payload: OpenAiImagesResponse): MediaOutputRef[] {
    const refs: MediaOutputRef[] = []
    for (const image of payload.data ?? []) {
      if (typeof image.b64_json === 'string') {
        refs.push({
          kind: 'inline',
          base64: image.b64_json,
          mime: mimeOf(payload.output_format) ?? 'image/png',
        })
        continue
      }
      if (typeof image.url === 'string') {
        const mime = mimeOf(payload.output_format, image.url)
        refs.push({
          kind: 'url',
          url: image.url,
          ...(mime ? { mime } : {}),
          // Only when the provider actually sent one. OpenAI does not, and a
          // fabricated expiry would end up in the library's provenance record
          // as though it were fact.
          ...(typeof image.expires_at === 'number'
            ? { expires_at: image.expires_at }
            : {}),
        })
      }
    }
    return refs
  }

  function snapshotOf(
    handle: MediaJobHandle,
    providerJobId: string,
    state: MediaJobSnapshot['state'],
    extra: Partial<MediaJobSnapshot> = {}
  ): MediaJobSnapshot {
    return {
      client_job_id: handle.client_job_id,
      provider_job_id: providerJobId,
      provider_id: descriptor.id,
      state,
      progress: null,
      step: null,
      queue_position: null,
      outputs: [],
      error: null,
      ...extra,
    }
  }

  return {
    descriptor,

    async health(signal?: AbortSignal): Promise<MediaProviderHealth> {
      try {
        const response = await fetch(`${base}/models`, {
          headers: { ...(await authorization()) },
          signal,
        })
        if (response.status === 401 || response.status === 403) {
          return {
            state: 'unauthorised',
            detail: (await errorFor(response)).message,
          }
        }
        if (!response.ok) {
          return { state: 'offline', detail: (await errorFor(response)).message }
        }
        return { state: 'online', service: descriptor.label }
      } catch (error) {
        if (error instanceof RemoteHttpError && error.code === 'no_api_key') {
          return { state: 'unauthorised', detail: error.message }
        }
        return {
          state: 'offline',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    },

    async capabilities(signal?: AbortSignal): Promise<MediaCapabilities> {
      // Reached only to confirm the endpoint answers; the model list is
      // declared. The call still honours the caller's signal, which the
      // conformance suite requires of every adapter.
      try {
        await fetch(`${base}/models`, {
          headers: { ...(await authorization()) },
          signal,
        })
      } catch {
        // Capabilities are static, so an unreachable provider still has a
        // truthful answer to give. Health is where reachability is reported.
      }

      return {
        contract_version: MEDIA_CONTRACT_VERSION,
        provider_id: descriptor.id,
        devices: [],
        models: declaredModels(descriptor.id),
        tasks: [
          {
            id: MEDIA_TASK.TEXT_TO_IMAGE,
            label_key: `media:task.${MEDIA_TASK.TEXT_TO_IMAGE}`,
            output_media_type: 'image',
          },
        ],
        features: {
          // No cancel endpoint and no event stream exist for images. Claiming
          // either would put a control in the UI that cannot work.
          cancel: false,
          events: false,
          progress: false,
          queue: false,
          install: false,
          batch: true,
          // The result arrives in the submit response; there is no job to
          // query. Declared so the caller - and the conformance suite - knows
          // which kind of `poll` this is. See tracker decision D7.
          synchronous: true,
        },
      }
    },

    async submit(
      req: NormalizedMediaRequest,
      signal?: AbortSignal
    ): Promise<MediaJobSnapshot> {
      const localId = req.model_id.startsWith(`${descriptor.id}:`)
        ? req.model_id.slice(descriptor.id.length + 1)
        : req.model_id

      const headers = {
        'content-type': 'application/json',
        ...(await authorization()),
      }

      // Awaited only as far as the headers. The body is deliberately left in
      // flight so the caller gets a live job rather than a completed one.
      const response = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: localId, ...req.params }),
        signal,
      })

      if (!response.ok) throw await errorFor(response)

      const providerJobId =
        response.headers?.get('x-request-id') ?? req.client_job_id

      const entry: Pending = { providerJobId, status: 'pending' }
      // Recorded as it lands rather than awaited here. `poll` reads the flag,
      // so a job is never blocked on a body that has not arrived.
      void (response.json() as Promise<OpenAiImagesResponse>).then(
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

      return snapshotOf(
        { client_job_id: req.client_job_id },
        providerJobId,
        'queued'
      )
    },

    async poll(handle: MediaJobHandle): Promise<MediaJobSnapshot> {
      const entry = pending.get(handle.client_job_id)
      if (!entry) {
        throw new RemoteHttpError(
          `No remote generation is in flight for client job "${handle.client_job_id}".`,
          'unknown_job'
        )
      }
      if (entry.settled) return entry.settled

      // Never re-sends: the request was made once, at submit. A poll that
      // repeated it would generate - and charge - a second time.
      //
      // One microtask turn is yielded first so that a body which has already
      // arrived has recorded itself before this decides the job is still
      // running. Without it a poll in the same tick as the response would
      // report `running` for a job that had in fact finished.
      await Promise.resolve()

      if (entry.status === 'pending') {
        return snapshotOf(handle, entry.providerJobId, 'running')
      }

      if (entry.status === 'rejected') {
        const settled = snapshotOf(handle, entry.providerJobId, 'failed', {
          error: {
            code: 'transport_error',
            message:
              entry.reason instanceof Error
                ? entry.reason.message
                : String(entry.reason),
            retryable: true,
          },
        })
        entry.settled = settled
        return settled
      }

      const outputs = outputsOf(entry.payload ?? {})
      const settled =
        outputs.length > 0
          ? snapshotOf(handle, entry.providerJobId, 'succeeded', {
              progress: 100,
              outputs,
            })
          : snapshotOf(handle, entry.providerJobId, 'failed', {
              error: {
                code: 'empty_response',
                message:
                  'The provider returned no image. Its `data` array was absent or empty.',
                retryable: true,
              },
            })

      entry.settled = settled
      return settled
    },

    // No cancel, subscribe or install: the images API offers no endpoint for
    // any of them, and features.* says so.
  }
}

/**
 * fal.ai adapter tests.
 *
 * Fixtures follow fal's queue documentation
 * (/docs/documentation/model-apis/inference/queue), its error references
 * (/model-apis/errors, /model-apis/request-errors), the models' OpenAPI
 * schemas from `GET https://api.fal.ai/v1/models?expand=openapi-3.0`, and
 * responses captured live on 2026-10-09 (both 401 bodies are verbatim). Not
 * from memory: AGENTS.md 6.2.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { MEDIA_TASK } from '../../contract'
import type { MediaJobState, MediaProviderDescriptor } from '../../contract'
import { FalAiError, createFalAiAdapter } from '../falAi'
import {
  describeMediaAdapterConformance,
  type ConformanceScenarios,
} from './conformance'
import {
  connectionRefused,
  decodeBody,
  hangUntilAborted,
  jsonResponse,
  type RecordedRequest,
} from './httpFakes'

const API_KEY =
  '5e1f0c3a-7d2b-4c19-9b1e-2a3f4d5e6f70:0123456789abcdef0123456789abcdef'
const QUEUE = 'https://queue.fal.run'
const PLATFORM = 'https://api.fal.ai/v1'
const MODEL = 'fal-ai/flux/schnell'

const descriptor: MediaProviderDescriptor = {
  id: 'fal-ai',
  label: 'fal.ai',
  kind: 'remote_http',
  adapter: 'fal-ai',
  auth: { type: 'api_key', setting_key: 'media.fal-ai.api_key' },
  enabled: true,
  origin: 'user',
}

// --- fixtures ------------------------------------------------------------------

/** Verbatim from the live queue API, 2026-10-09. */
const QUEUE_UNAUTHORISED = { detail: 'invalid key credentials' }
/** Verbatim from the live Platform API, 2026-10-09. */
const PLATFORM_UNAUTHORISED = {
  error: { type: 'authorization_error', message: 'Invalid API key' },
}

/** fal's model-error shape: `detail` is an array of typed errors. */
const VALIDATION_ERROR = {
  detail: [
    {
      loc: ['body', 'num_images'],
      msg: 'Input should be less than or equal to 4',
      type: 'less_than_equal',
      url: 'https://docs.pydantic.dev/2.10/v/less_than_equal',
      ctx: { le: 4 },
      input: 6,
    },
  ],
}

const urlsFor = (model: string, id: string, origin = QUEUE) => ({
  response_url: `${origin}/${model}/requests/${id}`,
  status_url: `${origin}/${model}/requests/${id}/status`,
  cancel_url: `${origin}/${model}/requests/${id}/cancel`,
})

function statusIn(id: string, state: MediaJobState) {
  const urls = urlsFor(MODEL, id)
  switch (state) {
    case 'queued':
      return {
        status: 'IN_QUEUE',
        request_id: id,
        queue_position: 2,
        response_url: urls.response_url,
      }
    case 'running':
      return {
        status: 'IN_PROGRESS',
        request_id: id,
        response_url: urls.response_url,
        logs: [
          {
            message: 'Loading model',
            level: 'INFO',
            source: 'user',
            timestamp: '2026-10-09T14:00:01Z',
          },
        ],
      }
    case 'succeeded':
      return {
        status: 'COMPLETED',
        request_id: id,
        response_url: urls.response_url,
        logs: null,
        metrics: { inference_time: 0.41 },
      }
    case 'failed':
      return {
        status: 'COMPLETED',
        request_id: id,
        response_url: urls.response_url,
        error: 'Request timed out',
        error_type: 'request_timeout',
      }
    case 'cancelled':
      return {
        status: 'COMPLETED',
        request_id: id,
        response_url: urls.response_url,
        error: 'Request was cancelled',
        error_type: 'client_cancelled',
      }
  }
}

const FLUX_RESULT = {
  images: [
    {
      url: 'https://v3.fal.media/files/rabbit/abc123_d4e5f6.jpeg',
      width: 1024,
      height: 768,
      content_type: 'image/jpeg',
    },
  ],
  timings: { inference: 0.38 },
  seed: 1234567,
  has_nsfw_concepts: [false],
  prompt: 'conformance',
}

const WAN_RESULT = {
  video: {
    url: 'https://v3.fal.media/files/zebra/9f8e7d_output.mp4',
    content_type: 'video/mp4',
    file_name: 'output.mp4',
    file_size: 4404019,
  },
  seed: 42,
  prompt: 'a fox',
}

const MODELS_LISTING = {
  models: [
    {
      endpoint_id: 'fal-ai/flux/schnell',
      metadata: {
        display_name: 'FLUX.1 [schnell]',
        category: 'text-to-image',
        status: 'active',
      },
    },
    {
      endpoint_id: 'fal-ai/wan/v2.2-a14b/text-to-video',
      metadata: {
        display_name: 'Wan-2.2 Text-to-Video A14B',
        category: 'text-to-video',
        status: 'active',
      },
    },
    {
      endpoint_id: 'fal-ai/wan/v2.2-a14b/image-to-video',
      metadata: {
        display_name: 'Wan-2.2 Image-to-Video A14B',
        category: 'image-to-video',
        status: 'active',
      },
    },
  ],
  next_cursor: null,
  has_more: false,
}

// --- mock transport -------------------------------------------------------------

type State = {
  reachable: boolean
  authorised: boolean
  hang: boolean
  requestId: string
  states: MediaJobState[]
  result: unknown
  listing: unknown
  submitUrls?: Record<string, string>
  requests: RecordedRequest[]
  override?: (request: RecordedRequest) => Response | undefined
}

let state: State

function transport(input: string, init: RequestInit = {}): Promise<Response> {
  const request: RecordedRequest = {
    url: input,
    method: init.method ?? 'GET',
    headers: { ...((init.headers as Record<string, string>) ?? {}) },
    body: decodeBody(init.body),
    signal: init.signal ?? undefined,
  }
  state.requests.push(request)

  if (!state.reachable) return Promise.reject(connectionRefused())
  if (state.hang) return hangUntilAborted(init.signal ?? undefined)
  const overridden = state.override?.(request)
  if (overridden) return Promise.resolve(overridden)

  // Model metadata: no key required, and none should be sent.
  if (input.startsWith(`${PLATFORM}/models?`)) {
    return Promise.resolve(jsonResponse(200, state.listing))
  }

  const keyed =
    request.headers.Authorization === `Key ${API_KEY}` && state.authorised
  if (input.startsWith(`${PLATFORM}/models/requests/by-endpoint`)) {
    return Promise.resolve(
      keyed
        ? jsonResponse(200, { items: [], next_cursor: null, has_more: false })
        : jsonResponse(401, PLATFORM_UNAUTHORISED)
    )
  }
  if (!keyed) return Promise.resolve(jsonResponse(401, QUEUE_UNAUTHORISED))

  const url = new URL(input)
  const path = url.pathname.slice(1)
  if (request.method === 'POST') {
    return Promise.resolve(
      jsonResponse(200, {
        status: 'IN_QUEUE',
        request_id: state.requestId,
        ...(state.submitUrls ?? urlsFor(path, state.requestId, url.origin)),
        queue_position: 0,
      })
    )
  }
  if (request.method === 'PUT' && path.endsWith('/cancel')) {
    return Promise.resolve(
      jsonResponse(202, { status: 'CANCELLATION_REQUESTED' })
    )
  }
  if (path.endsWith('/status')) {
    const next =
      state.states.length > 1 ? state.states.shift()! : state.states[0]
    return Promise.resolve(
      jsonResponse(200, statusIn(state.requestId, next ?? 'queued'))
    )
  }
  if (/\/requests\/[^/]+$/.test(path))
    return Promise.resolve(jsonResponse(200, state.result))
  return Promise.resolve(jsonResponse(404, { detail: 'Not Found' }))
}

beforeEach(() => {
  state = {
    reachable: true,
    authorised: true,
    hang: false,
    requestId: '764cabcf-b745-4b3e-ae38-1200304cf45b',
    states: ['queued'],
    result: FLUX_RESULT,
    listing: MODELS_LISTING,
    requests: [],
  }
})

const create = (
  d: MediaProviderDescriptor = descriptor,
  resolveSecret: () => Promise<string | undefined> = async () => API_KEY
) => createFalAiAdapter(d, { fetch: transport, resolveSecret })

const scenarios: ConformanceScenarios = {
  online() {
    state.reachable = true
    state.authorised = true
  },
  unreachable() {
    state.reachable = false
  },
  unauthorised() {
    state.reachable = true
    state.authorised = false
    return true
  },
  capabilities() {
    state.reachable = true
    state.authorised = true
  },
  acceptsSubmit(providerJobId) {
    state.reachable = true
    state.authorised = true
    state.requestId = providerJobId
  },
  jobStates(states) {
    state.states = [...states]
  },
  synchronous: () => false,
  lastSignal: () => state.requests.at(-1)?.signal,
  callCount: () => state.requests.length,
}

describeMediaAdapterConformance({
  name: 'fal.ai',
  descriptor,
  createAdapter: (d) => create(d),
  scenarios,
})

// --- provider-specific behaviour --------------------------------------------------

const request = (
  params: Record<string, unknown> = { prompt: 'a red fox' }
) => ({
  client_job_id: '01JFALJOB000000000000000',
  provider_id: 'fal-ai',
  model_id: `fal-ai:${MODEL}`,
  task: MEDIA_TASK.TEXT_TO_IMAGE,
  params,
})

describe('fal.ai — queue lifecycle', () => {
  it('submits the params as the body, with a Key credential', async () => {
    const snapshot = await create().submit(
      request({ prompt: 'a red fox', image_size: 'square_hd', num_images: 2 })
    )

    const sent = state.requests.at(-1)!
    expect(sent).toMatchObject({ method: 'POST', url: `${QUEUE}/${MODEL}` })
    expect(sent.headers).toMatchObject({
      'Authorization': `Key ${API_KEY}`,
      'Content-Type': 'application/json',
    })
    expect(sent.body).toEqual({
      prompt: 'a red fox',
      image_size: 'square_hd',
      num_images: 2,
    })
    expect(snapshot).toMatchObject({
      state: 'queued',
      provider_job_id: state.requestId,
      queue_position: 0,
    })
  })

  it('polls the status URL fal returned and reports the queue position', async () => {
    const adapter = create()
    const submitted = await adapter.submit(request())
    state.states = ['queued']

    await expect(adapter.poll(submitted)).resolves.toMatchObject({
      state: 'queued',
      queue_position: 2,
    })
    expect(state.requests.at(-1)!.url).toBe(
      `${QUEUE}/${MODEL}/requests/${state.requestId}/status`
    )
  })

  it('fetches the result from the response URL once COMPLETED', async () => {
    const adapter = create()
    const submitted = await adapter.submit(request())
    state.states = ['succeeded']

    const settled = await adapter.poll(submitted)

    expect(state.requests.at(-1)!.url).toBe(
      `${QUEUE}/${MODEL}/requests/${state.requestId}`
    )
    expect(settled).toMatchObject({
      state: 'succeeded',
      progress: 100,
      outputs: [
        { kind: 'url', url: FLUX_RESULT.images[0]!.url, mime: 'image/jpeg' },
      ],
    })
  })

  it('reads a video model’s `video` file', async () => {
    const adapter = create()
    const submitted = await adapter.submit({
      ...request(),
      model_id: 'fal-ai:fal-ai/wan/v2.2-a14b/text-to-video',
      task: MEDIA_TASK.TEXT_TO_VIDEO,
    })
    state.states = ['succeeded']
    state.result = WAN_RESULT

    await expect(adapter.poll(submitted)).resolves.toMatchObject({
      state: 'succeeded',
      outputs: [{ kind: 'url', url: WAN_RESULT.video.url, mime: 'video/mp4' }],
    })
  })

  it('translates a chat `length_seconds` into fal frames at the default fps', async () => {
    await create().submit({
      ...request({ prompt: 'waves', length_seconds: 8 }),
      model_id: 'fal-ai:fal-ai/wan/v2.2-a14b/text-to-video',
      task: MEDIA_TASK.TEXT_TO_VIDEO,
    })

    expect(state.requests.at(-1)!.body).toEqual({
      prompt: 'waves',
      num_frames: 128,
      frames_per_second: 16,
    })
  })

  it('keeps fal native frames when the caller already set them', async () => {
    await create().submit({
      ...request({ prompt: 'waves', num_frames: 81, frames_per_second: 16 }),
      model_id: 'fal-ai:fal-ai/wan/v2.2-a14b/text-to-video',
      task: MEDIA_TASK.TEXT_TO_VIDEO,
    })

    expect(state.requests.at(-1)!.body).toEqual({
      prompt: 'waves',
      num_frames: 81,
      frames_per_second: 16,
    })
  })

  it('snaps a long clip to fal’s frame window and keeps the chosen fps', async () => {
    await create().submit({
      ...request({ prompt: 'waves', length_seconds: 30, fps: 60 }),
      model_id: 'fal-ai:fal-ai/wan/v2.2-a14b/text-to-video',
      task: MEDIA_TASK.TEXT_TO_VIDEO,
    })

    expect(state.requests.at(-1)!.body).toEqual({
      prompt: 'waves',
      num_frames: 161,
      frames_per_second: 60,
    })
  })

  it('offers a length ladder and buries the frame keys under advanced', async () => {
    const models = (await create().capabilities()).models
    const video = models.find((model) =>
      model.tasks.includes(MEDIA_TASK.TEXT_TO_VIDEO)
    )
    const specs = video!.params.text_to_video

    const length = specs.find((spec) => spec.id === 'length_seconds')
    const frames = specs.find((spec) => spec.id === 'num_frames')
    const fps = specs.find((spec) => spec.id === 'frames_per_second')

    expect(length?.type).toBe('enum')
    expect(length?.options.map((option) => option.value)).toEqual([1, 2, 3, 4, 5, 8, 10])
    expect(length?.default).toBe(5)
    expect(frames?.advanced).toBe(true)
    expect(fps?.advanced).toBe(true)
  })

  it('declares an image-to-video model and passes its starting image through', async () => {
    const models = (await create().capabilities()).models
    const i2v = models.find(
      (model) =>
        model.local_id === 'fal-ai/wan/v2.2-a14b/image-to-video'
    )!
    const specs = i2v.params.text_to_video
    const image = specs.find((spec) => spec.id === 'image_url')

    expect(i2v.tasks).toEqual([MEDIA_TASK.TEXT_TO_VIDEO])
    expect(image).toMatchObject({
      type: 'image_ref',
      accept: ['image/png', 'image/jpeg', 'image/webp'],
    })

    const dataUrl = 'data:image/png;base64,AAAA'
    await create().submit({
      client_job_id: '01JFALJOB000000000000000',
      provider_id: 'fal-ai',
      model_id: 'fal-ai:fal-ai/wan/v2.2-a14b/image-to-video',
      task: MEDIA_TASK.TEXT_TO_VIDEO,
      params: { prompt: 'pan over the meadow', image_url: dataUrl, length_seconds: 5 },
    })

    expect(state.requests.at(-1)!.body).toEqual({
      prompt: 'pan over the meadow',
      image_url: dataUrl,
      num_frames: 80,
      frames_per_second: 16,
    })
  })

  it('treats a COMPLETED request with an error as failed, retryable per its error_type', async () => {
    const adapter = create()
    const submitted = await adapter.submit(request())
    state.states = ['failed']

    await expect(adapter.poll(submitted)).resolves.toMatchObject({
      state: 'failed',
      outputs: [],
      error: {
        code: 'request_timeout',
        message: 'Request timed out',
        retryable: true,
      },
    })
  })

  it('reports a model validation error from the result as a non-retryable failure', async () => {
    const adapter = create()
    const submitted = await adapter.submit(request())
    state.states = ['succeeded']
    state.override = (sent) =>
      sent.method === 'GET' && /\/requests\/[^/]+$/.test(sent.url)
        ? jsonResponse(422, VALIDATION_ERROR)
        : undefined

    await expect(adapter.poll(submitted)).resolves.toMatchObject({
      state: 'failed',
      error: {
        code: 'less_than_equal',
        message: 'Input should be less than or equal to 4',
        retryable: false,
      },
    })
  })

  it('throws, rather than failing the job, when the result endpoint itself errors', async () => {
    const adapter = create()
    const submitted = await adapter.submit(request())
    state.states = ['succeeded']
    state.override = (sent) =>
      sent.method === 'GET' && /\/requests\/[^/]+$/.test(sent.url)
        ? jsonResponse(503, {
            detail: 'Service unavailable',
            error_type: 'runner_connection_error',
          })
        : undefined

    await expect(adapter.poll(submitted)).rejects.toMatchObject({
      code: 'runner_connection_error',
      retryable: true,
    })
  })

  it('refuses to poll a job it never submitted', async () => {
    await expect(
      create().poll({ client_job_id: 'stranger', provider_job_id: 'x' })
    ).rejects.toMatchObject({ code: 'unknown_job' })
  })
})

describe('fal.ai — where the key goes', () => {
  it('derives URLs from the configured origin when fal returns ones elsewhere', async () => {
    state.submitUrls = urlsFor(
      MODEL,
      state.requestId,
      'https://attacker.example'
    )
    const adapter = create()
    const submitted = await adapter.submit(request())

    await adapter.poll(submitted)

    const sentKeys = state.requests.filter((r) => r.headers.Authorization)
    expect(sentKeys.length).toBeGreaterThan(0)
    const queueOrigin = new URL(QUEUE).origin
    expect(sentKeys.map((r) => new URL(r.url).origin)).toEqual(
      sentKeys.map(() => queueOrigin)
    )
    expect(state.requests.at(-1)!.url).toBe(
      `${QUEUE}/${MODEL}/requests/${state.requestId}/status`
    )
  })

  it('keeps every keyed request on a gateway base URL', async () => {
    const gateway = { ...descriptor, base_url: 'https://gateway.example.com/' }
    const adapter = create(gateway)

    const job = await adapter.submit({
      ...request(),
      model_id: 'fal-ai:custom/model',
    })
    state.states = ['succeeded']
    await adapter.poll(job)
    await adapter.health()

    const keyed = state.requests.filter((r) => r.headers.Authorization)
    expect(keyed.map((r) => r.url)).toEqual([
      'https://gateway.example.com/custom/model',
      `https://gateway.example.com/custom/model/requests/${state.requestId}/status`,
      `https://gateway.example.com/custom/model/requests/${state.requestId}`,
    ])
  })

  it('sends no key with the model-metadata request', async () => {
    await create().capabilities()

    const metadata = state.requests.find((r) =>
      r.url.startsWith(`${PLATFORM}/models?`)
    )!
    expect(metadata.headers).not.toHaveProperty('Authorization')
  })
})

describe('fal.ai — health and errors', () => {
  it('checks the key against the Platform API', async () => {
    await expect(create().health()).resolves.toEqual({
      state: 'online',
      service: 'fal.ai',
    })
    expect(state.requests.at(-1)!.url).toMatch(
      /^https:\/\/api\.fal\.ai\/v1\/models\/requests\/by-endpoint\?/
    )
  })

  it('reports a rejected key as unauthorised in fal’s words', async () => {
    state.authorised = false

    await expect(create().health()).resolves.toEqual({
      state: 'unauthorised',
      detail: 'Invalid API key',
    })
  })

  it('treats a key that authenticates but lacks the history scope as online', async () => {
    state.override = (sent) =>
      sent.url.includes('/requests/by-endpoint')
        ? jsonResponse(403, {
            error: {
              type: 'authorization_error',
              message: 'Missing permission models:requests:read',
            },
          })
        : undefined

    await expect(create().health()).resolves.toMatchObject({
      state: 'online',
      detail: expect.stringContaining('models:requests:read'),
    })
  })

  it('maps a 429 on submit to a retryable error with Retry-After', async () => {
    state.override = (sent) =>
      sent.method === 'POST'
        ? jsonResponse(
            429,
            { detail: 'Rate limit exceeded' },
            { 'retry-after': '5' }
          )
        : undefined

    const error = await create()
      .submit(request())
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(FalAiError)
    expect(error).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      retryAfterMs: 5000,
    })
  })

  it('honours fal’s X-Fal-Needs-Retry hint over the status code', async () => {
    state.override = (sent) =>
      sent.method === 'POST'
        ? jsonResponse(500, VALIDATION_ERROR, { 'x-fal-needs-retry': '0' })
        : undefined

    await expect(create().submit(request())).rejects.toMatchObject({
      retryable: false,
    })
  })

  it('reports a rejected key on submit with fal’s message', async () => {
    state.authorised = false

    await expect(create().submit(request())).rejects.toMatchObject({
      code: 'unauthorised',
      message: 'invalid key credentials',
    })
  })
})

describe('fal.ai — cancellation', () => {
  async function submitted() {
    const adapter = create()
    const job = await adapter.submit(request())
    return { adapter, job }
  }

  it('cancels with PUT to the cancel URL', async () => {
    const { adapter, job } = await submitted()

    await expect(adapter.cancel!(job)).resolves.toBeUndefined()
    expect(state.requests.at(-1)).toMatchObject({
      method: 'PUT',
      url: `${QUEUE}/${MODEL}/requests/${state.requestId}/cancel`,
    })
  })

  it('accepts ALREADY_COMPLETED: there is nothing left to stop', async () => {
    const { adapter, job } = await submitted()
    state.override = (sent) =>
      sent.method === 'PUT'
        ? jsonResponse(400, { status: 'ALREADY_COMPLETED' })
        : undefined

    await expect(adapter.cancel!(job)).resolves.toBeUndefined()
  })

  it('rejects NOT_FOUND so the job is not marked cancelled on a guess', async () => {
    const { adapter, job } = await submitted()
    state.override = (sent) =>
      sent.method === 'PUT'
        ? jsonResponse(404, { status: 'NOT_FOUND' })
        : undefined

    await expect(adapter.cancel!(job)).rejects.toMatchObject({ status: 404 })
  })
})

describe('fal.ai — capabilities, timeouts and aborts', () => {
  it('labels a deprecated model and drops one fal no longer lists', async () => {
    state.listing = {
      models: [{ endpoint_id: MODEL, metadata: { status: 'deprecated' } }],
      next_cursor: null,
      has_more: false,
    }

    const capabilities = await create().capabilities()

    expect(capabilities.models.map((m) => [m.local_id, m.label])).toEqual([
      [MODEL, 'FLUX.1 [schnell] (deprecated)'],
    ])
  })

  it('keeps the declared models when fal cannot be reached', async () => {
    state.reachable = false

    await expect(create().capabilities()).resolves.toMatchObject({
      models: [
        { local_id: MODEL },
        { local_id: 'fal-ai/wan/v2.2-a14b/text-to-video' },
        { local_id: 'fal-ai/wan/v2.2-a14b/image-to-video' },
      ],
    })
  })

  it('abandons a hung status poll when the caller aborts', async () => {
    const adapter = create()
    const job = await adapter.submit(request())
    state.hang = true
    const controller = new AbortController()

    const pending = adapter.poll(job, controller.signal)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('applies a deadline to a poll made without a signal', async () => {
    const adapter = create()
    const job = await adapter.submit(request())

    await adapter.poll(job)

    expect(state.requests.at(-1)!.signal).toBeInstanceOf(AbortSignal)
  })
})

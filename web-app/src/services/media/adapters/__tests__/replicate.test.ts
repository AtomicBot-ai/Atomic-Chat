/**
 * Replicate adapter tests.
 *
 * Fixtures follow Replicate's published OpenAPI document
 * (https://api.replicate.com/openapi.json), the models' own input schemas on
 * replicate.com, and responses captured live from the API on 2026-10-09 (the
 * 401 problem-details bodies are verbatim). Not from memory: AGENTS.md 6.2.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MEDIA_TASK } from '../../contract'
import type { MediaJobState, MediaProviderDescriptor } from '../../contract'
import { ReplicateError, createReplicateAdapter } from '../replicate'
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

const API_TOKEN = 'r8_TESTsecretTOKEN0123456789abcdefABCDEF'
const BASE = 'https://api.replicate.com/v1'

const descriptor: MediaProviderDescriptor = {
  id: 'replicate',
  label: 'Replicate',
  kind: 'remote_http',
  adapter: 'replicate',
  auth: { type: 'api_key', setting_key: 'media.replicate.api_key' },
  enabled: true,
  origin: 'user',
}

// --- fixtures ------------------------------------------------------------------

/** Verbatim from the live API, 2026-10-09. */
const UNAUTHENTICATED = {
  title: 'Unauthenticated',
  detail: 'You did not pass a valid authentication token',
  status: 401,
}

/** Replicate's throttling response: problem details plus Retry-After. */
const THROTTLED = {
  title: 'Request was throttled.',
  detail: 'Request was throttled. Expected available in 2 seconds.',
  status: 429,
}

const INVALID_INPUT = {
  title: 'Input validation failed',
  detail: '- input.num_outputs: Must be less than or equal to 4',
  status: 422,
  invalid_fields: [
    {
      type: 'less_than_equal',
      field: 'input.num_outputs',
      description: 'Must be less than or equal to 4',
    },
  ],
}

const ACCOUNT = {
  type: 'user',
  username: 'radium-test',
  name: 'Radium Test',
  github_url: 'https://github.com/radium-test',
}

function prediction(
  id: string,
  status: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    model: 'black-forest-labs/flux-schnell',
    version: 'hidden',
    input: { prompt: 'conformance' },
    logs: '',
    output: null,
    data_removed: false,
    error: null,
    status,
    source: 'api',
    created_at: '2026-10-09T14:00:00.000Z',
    started_at: status === 'starting' ? null : '2026-10-09T14:00:01.500Z',
    completed_at: ['succeeded', 'failed', 'canceled'].includes(status)
      ? '2026-10-09T14:00:03.250Z'
      : null,
    urls: {
      cancel: `${BASE}/predictions/${id}/cancel`,
      get: `${BASE}/predictions/${id}`,
      stream: `https://stream.replicate.com/v1/files/${id}`,
      web: `https://replicate.com/p/${id}`,
    },
    ...extra,
  }
}

const TQDM_HALF =
  'Using seed: 12345\nrunning quantized prediction\n 50%|█████     | 2/4 [00:00<00:00,  6.10it/s]'

function predictionIn(id: string, state: MediaJobState) {
  switch (state) {
    case 'queued':
      return prediction(id, 'starting')
    case 'running':
      return prediction(id, 'processing', { logs: TQDM_HALF })
    case 'succeeded':
      return prediction(id, 'succeeded', {
        logs: `${TQDM_HALF}\n100%|██████████| 4/4 [00:00<00:00,  6.20it/s]`,
        output: [`https://replicate.delivery/xezq/${id}/out-0.webp`],
        metrics: { predict_time: 0.61, total_time: 3.25 },
      })
    case 'failed':
      return prediction(id, 'failed', {
        error:
          'NSFW content detected. Try running it again, or try a different prompt.',
      })
    case 'cancelled':
      return prediction(id, 'canceled')
  }
}

// --- mock transport -------------------------------------------------------------

type State = {
  reachable: boolean
  authorised: boolean
  throttled: boolean
  hang: boolean
  predictionId: string
  states: MediaJobState[]
  retired: Set<string>
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
  if (
    request.headers.Authorization !== `Bearer ${API_TOKEN}` ||
    !state.authorised
  ) {
    return Promise.resolve(
      jsonResponse(401, UNAUTHENTICATED, {
        'content-type': 'application/problem+json',
      })
    )
  }
  if (state.throttled) {
    return Promise.resolve(
      jsonResponse(429, THROTTLED, {
        'content-type': 'application/problem+json',
        'retry-after': '2',
      })
    )
  }

  const path = input.slice(BASE.length)
  if (path === '/account') return Promise.resolve(jsonResponse(200, ACCOUNT))

  const create = /^\/models\/([^/]+\/[^/]+)\/predictions$/.exec(path)
  if (create && request.method === 'POST') {
    return Promise.resolve(
      jsonResponse(
        201,
        prediction(state.predictionId, 'starting', { model: create[1] })
      )
    )
  }
  const model = /^\/models\/([^/]+\/[^/]+)$/.exec(path)
  if (model) {
    if (state.retired.has(model[1])) {
      return Promise.resolve(
        jsonResponse(404, {
          title: 'Not found',
          detail: 'Not found.',
          status: 404,
        })
      )
    }
    return Promise.resolve(
      jsonResponse(200, {
        url: `https://replicate.com/${model[1]}`,
        owner: model[1].split('/')[0],
        name: model[1].split('/')[1],
        visibility: 'public',
        latest_version: { id: 'hidden' },
      })
    )
  }
  const cancel = /^\/predictions\/([^/]+)\/cancel$/.exec(path)
  if (cancel && request.method === 'POST') {
    return Promise.resolve(jsonResponse(200, prediction(cancel[1], 'canceled')))
  }
  const get = /^\/predictions\/([^/]+)$/.exec(path)
  if (get) {
    const next =
      state.states.length > 1 ? state.states.shift()! : state.states[0]
    return Promise.resolve(
      jsonResponse(200, predictionIn(get[1], next ?? 'queued'))
    )
  }
  return Promise.resolve(jsonResponse(404, { title: 'Not found', status: 404 }))
}

beforeEach(() => {
  state = {
    reachable: true,
    authorised: true,
    throttled: false,
    hang: false,
    predictionId: 'gm3qorzdhgbfurvjtvhg6dckhu',
    states: ['queued'],
    retired: new Set(),
    requests: [],
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

const create = (
  d: MediaProviderDescriptor = descriptor,
  resolveSecret: () => Promise<string | undefined> = async () => API_TOKEN
) => createReplicateAdapter(d, { fetch: transport, resolveSecret })

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
    state.throttled = false
    state.predictionId = providerJobId
  },
  jobStates(states) {
    state.states = [...states]
  },
  synchronous: () => false,
  lastSignal: () => state.requests.at(-1)?.signal,
  callCount: () => state.requests.length,
}

describeMediaAdapterConformance({
  name: 'Replicate',
  descriptor,
  createAdapter: (d) => create(d),
  scenarios,
})

// --- provider-specific behaviour --------------------------------------------------

const request = (
  params: Record<string, unknown> = { prompt: 'a red fox' }
) => ({
  client_job_id: '01JREPLICATEJOB000000000',
  provider_id: 'replicate',
  model_id: 'replicate:black-forest-labs/flux-schnell',
  task: MEDIA_TASK.TEXT_TO_IMAGE,
  params,
})

describe('Replicate — wire format', () => {
  it('creates the prediction on the official-model route with the params as input', async () => {
    const snapshot = await create().submit(
      request({
        prompt: 'a red fox',
        aspect_ratio: '16:9',
        num_outputs: 2,
        seed: 7,
      })
    )

    const sent = state.requests.at(-1)!
    expect(sent.method).toBe('POST')
    expect(sent.url).toBe(
      `${BASE}/models/black-forest-labs/flux-schnell/predictions`
    )
    expect(sent.headers).toMatchObject({
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    })
    // Not `Prefer: wait`: the job manager polls, and a held-open create would
    // block the submit for up to a minute.
    expect(sent.headers).not.toHaveProperty('Prefer')
    expect(sent.body).toEqual({
      input: {
        prompt: 'a red fox',
        aspect_ratio: '16:9',
        num_outputs: 2,
        seed: 7,
      },
    })
    expect(snapshot).toMatchObject({
      state: 'queued',
      provider_job_id: state.predictionId,
    })
  })

  it('declares only official models, whose inputs match their published schemas', async () => {
    const capabilities = await create().capabilities()

    expect(capabilities.models.map((model) => model.local_id)).toEqual([
      'black-forest-labs/flux-schnell',
      'minimax/video-01',
    ])
    const flux = capabilities.models[0]!.params[MEDIA_TASK.TEXT_TO_IMAGE]!
    expect(
      flux.find((spec) => spec.id === 'num_inference_steps')
    ).toMatchObject({
      min: 1,
      max: 4,
      default: 4,
    })
    expect(
      flux.find((spec) => spec.id === 'aspect_ratio')?.options
    ).toHaveLength(11)
  })

  it('reports progress from the tqdm bar in the logs while processing', async () => {
    const adapter = create()
    const submitted = await adapter.submit(request())
    state.states = ['running']

    await expect(adapter.poll(submitted)).resolves.toMatchObject({
      state: 'running',
      progress: 50,
    })
  })

  it('returns every output URL with its MIME type, including a single-string video output', async () => {
    const adapter = create()
    const submitted = await adapter.submit({
      ...request(),
      model_id: 'replicate:minimax/video-01',
      task: MEDIA_TASK.TEXT_TO_VIDEO,
    })
    state.override = (sent) =>
      sent.url.endsWith(`/predictions/${state.predictionId}`)
        ? jsonResponse(
            200,
            prediction(state.predictionId, 'succeeded', {
              output: 'https://replicate.delivery/xezq/abc/tmpvideo.mp4',
            })
          )
        : undefined

    const settled = await adapter.poll(submitted)

    expect(settled.state).toBe('succeeded')
    expect(settled.outputs).toEqual([
      {
        kind: 'url',
        url: 'https://replicate.delivery/xezq/abc/tmpvideo.mp4',
        mime: 'video/mp4',
      },
    ])
    expect(settled.finished_at).toBe(Date.parse('2026-10-09T14:00:03.250Z'))
  })

  it('treats `aborted` as a retryable failure, distinct from a model failure', async () => {
    const adapter = create()
    const submitted = await adapter.submit(request())
    state.override = (sent) =>
      sent.method === 'GET' && sent.url.includes('/predictions/')
        ? jsonResponse(200, prediction(state.predictionId, 'aborted'))
        : undefined

    await expect(adapter.poll(submitted)).resolves.toMatchObject({
      state: 'failed',
      error: { code: 'aborted', retryable: true },
    })
  })

  it('reports a model failure as not retryable, in Replicate’s own words', async () => {
    const adapter = create()
    const submitted = await adapter.submit(request())
    state.states = ['failed']

    await expect(adapter.poll(submitted)).resolves.toMatchObject({
      state: 'failed',
      outputs: [],
      error: {
        code: 'generation_failed',
        message: expect.stringContaining('NSFW content detected'),
        retryable: false,
      },
    })
  })

  it('refuses a local path for the first frame instead of sending it', async () => {
    await expect(
      create().submit({
        ...request({ prompt: 'x', first_frame_image: '/home/me/frame.png' }),
        model_id: 'replicate:minimax/video-01',
        task: MEDIA_TASK.TEXT_TO_VIDEO,
      })
    ).rejects.toMatchObject({ code: 'invalid_params' })
    expect(state.requests).toHaveLength(0)
  })
})

describe('Replicate — errors and rate limits', () => {
  it('maps a 429 to a retryable rate_limited error carrying Retry-After', async () => {
    state.throttled = true

    const error = await create()
      .submit(request())
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ReplicateError)
    expect(error).toMatchObject({
      code: 'rate_limited',
      status: 429,
      retryable: true,
      retryAfterMs: 2000,
      message: expect.stringContaining('throttled'),
    })
  })

  it('maps a 422 to a non-retryable error naming the invalid field', async () => {
    state.override = (sent) =>
      sent.method === 'POST' ? jsonResponse(422, INVALID_INPUT) : undefined

    await expect(create().submit(request())).rejects.toMatchObject({
      code: 'invalid_request',
      retryable: false,
      message: expect.stringContaining('Must be less than or equal to 4'),
    })
  })

  it('reports a rejected token as unauthorised, in Replicate’s words', async () => {
    state.authorised = false

    await expect(create().health()).resolves.toEqual({
      state: 'unauthorised',
      detail: 'You did not pass a valid authentication token',
    })
  })

  it('reports a missing key without making a request', async () => {
    const health = await create(descriptor, async () => undefined).health()

    expect(health).toMatchObject({ state: 'unauthorised' })
    expect(health.detail).toMatch(/no API key configured/)
    expect(state.requests).toHaveLength(0)
  })

  it('never puts the token into an error message', async () => {
    state.override = () =>
      jsonResponse(401, {
        ...UNAUTHENTICATED,
        detail: `Token ${API_TOKEN} is invalid`,
      })

    const health = await create().health()
    const error = await create()
      .submit(request())
      .catch((e: Error) => e)

    expect(health.detail).not.toContain(API_TOKEN)
    expect((error as Error).message).not.toContain(API_TOKEN)
    expect((error as Error).message).toContain('[redacted]')
  })
})

describe('Replicate — cancellation', () => {
  const handle = {
    client_job_id: 'job-1',
    provider_job_id: 'gm3qorzdhgbfurvjtvhg6dckhu',
  }

  it('cancels through the prediction’s cancel route', async () => {
    await expect(create().cancel!(handle)).resolves.toBeUndefined()

    expect(state.requests.at(-1)).toMatchObject({
      method: 'POST',
      url: `${BASE}/predictions/gm3qorzdhgbfurvjtvhg6dckhu/cancel`,
    })
  })

  it.each([401, 500])(
    'rejects HTTP %s so the job manager keeps tracking the job',
    async (status) => {
      state.override = () =>
        jsonResponse(status, { title: 'Nope', detail: 'Refused', status })

      await expect(create().cancel!(handle)).rejects.toMatchObject({ status })
    }
  )

  it('rejects a handle with no prediction id rather than pretending to cancel', async () => {
    await expect(
      create().cancel!({ client_job_id: 'job-1' })
    ).rejects.toMatchObject({
      code: 'unknown_job',
    })
    expect(state.requests).toHaveLength(0)
  })
})

describe('Replicate — capabilities, timeouts and aborts', () => {
  it('drops a model Replicate no longer serves', async () => {
    state.retired.add('minimax/video-01')

    const capabilities = await create().capabilities()

    expect(capabilities.models.map((model) => model.local_id)).toEqual([
      'black-forest-labs/flux-schnell',
    ])
  })

  it('keeps the declared models when Replicate cannot be reached', async () => {
    state.reachable = false

    await expect(create().capabilities()).resolves.toMatchObject({
      models: [
        { local_id: 'black-forest-labs/flux-schnell' },
        { local_id: 'minimax/video-01' },
      ],
    })
  })

  it('applies a deadline to a poll made without a signal', async () => {
    const adapter = create()
    const submitted = await adapter.submit(request())

    await adapter.poll(submitted)

    const signal = state.requests.at(-1)!.signal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal!.aborted).toBe(false)
  })

  it('abandons a hung poll when the caller aborts', async () => {
    const adapter = create()
    const submitted = await adapter.submit(request())
    state.hang = true
    const controller = new AbortController()

    const pending = adapter.poll(submitted, controller.signal)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reports a timed-out health probe as offline, saying so', async () => {
    state.hang = true

    const health = await create().health(AbortSignal.timeout(5))

    expect(health.state).toBe('offline')
    expect(health.detail).toBeTruthy()
  })
})

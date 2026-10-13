/**
 * Stability AI adapter tests.
 *
 * Fixtures follow Stability's published OpenAPI document
 * (https://api.stability.ai/v2alpha/openapi, rendered by the API reference at
 * platform.stability.ai) and responses captured live on 2026-10-09 (both 401
 * bodies are verbatim, including v1's habit of echoing the key). Not from
 * memory: AGENTS.md 6.2.
 *
 * The generate endpoints are synchronous, so - like the OpenAI-compatible
 * adapter - the conformance suite runs in its synchronous mode.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { MEDIA_TASK } from '../../contract'
import type { MediaJobState, MediaProviderDescriptor } from '../../contract'
import { StabilityAiError, createStabilityAiAdapter } from '../stabilityAi'
import {
  describeMediaAdapterConformance,
  type ConformanceScenarios,
} from './conformance'
import {
  connectionRefused,
  decodeBody,
  deferred,
  fakeResponse,
  hangUntilAborted,
  jsonResponse,
  type RecordedRequest,
} from './httpFakes'

// Deliberately low-entropy so it can never be mistaken for a real key.
const API_KEY = 'sk-test-stability-xxxxxxxxxxxxxxxx'
const BASE = 'https://api.stability.ai'

const descriptor: MediaProviderDescriptor = {
  id: 'stability-ai',
  label: 'Stability AI',
  kind: 'remote_http',
  adapter: 'stability-ai',
  auth: { type: 'api_key', setting_key: 'media.stability-ai.api_key' },
  enabled: true,
  origin: 'user',
}

// --- fixtures ------------------------------------------------------------------

/** 1x1 transparent PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const SUCCESS = { image: PNG_BASE64, seed: 343940597, finish_reason: 'SUCCESS' }
const FILTERED = {
  image: PNG_BASE64,
  seed: 343940597,
  finish_reason: 'CONTENT_FILTERED',
}

/** Verbatim from the live v1 API: it echoes the key that was sent. */
const balanceUnauthorised = (key: string) => ({
  id: '41978b143f73024a3785715f72140696',
  message: `Incorrect API key provided: ${key}. You can find your API key at https://stability.ai.`,
  name: 'unauthorized',
})
/** Verbatim from the live v2beta API. */
const GENERATE_UNAUTHORISED = {
  errors: ['authorization: invalid or missing header value'],
  id: 'fc0ade0f41d0b0fa7c563dd3d4ed714e',
  name: 'unauthorized',
}

// --- mock transport -------------------------------------------------------------

type State = {
  reachable: boolean
  authorised: boolean
  hang: boolean
  requestId: string
  body: () => Promise<unknown>
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

  const sentKey = request.headers.Authorization?.replace(/^Bearer /, '') ?? ''
  const keyed = sentKey === API_KEY && state.authorised

  if (input === `${BASE}/v1/user/balance`) {
    return Promise.resolve(
      keyed
        ? jsonResponse(200, { credits: 42.5 })
        : jsonResponse(401, balanceUnauthorised(sentKey))
    )
  }
  if (input.startsWith(`${BASE}/v2beta/stable-image/generate/`)) {
    if (!keyed) {
      return Promise.resolve(
        jsonResponse(401, GENERATE_UNAUTHORISED, {
          'x-request-id': GENERATE_UNAUTHORISED.id,
        })
      )
    }
    return Promise.resolve(
      fakeResponse(200, state.body, {
        'content-type': 'application/json; type=image/png',
        'x-request-id': state.requestId,
        'finish-reason': 'SUCCESS',
        'seed': '343940597',
      })
    )
  }
  return Promise.resolve(
    jsonResponse(404, { id: 'x', name: 'not_found', errors: ['Not found'] })
  )
}

beforeEach(() => {
  state = {
    reachable: true,
    authorised: true,
    hang: false,
    requestId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    body: () => Promise.resolve(SUCCESS),
    requests: [],
  }
})

const create = (
  d: MediaProviderDescriptor = descriptor,
  resolveSecret: () => Promise<string | undefined> = async () => API_KEY
) => createStabilityAiAdapter(d, { fetch: transport, resolveSecret })

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
    state.body = () => Promise.resolve(SUCCESS)
  },
  jobStates(states: MediaJobState[]) {
    // Synchronous: the outcome is decided by the submit's response body.
    const final = states.at(-1)
    state.body = () => Promise.resolve(final === 'failed' ? FILTERED : SUCCESS)
  },
  synchronous: () => true,
  lastSignal: () => state.requests.at(-1)?.signal,
  callCount: () => state.requests.length,
}

describeMediaAdapterConformance({
  name: 'Stability AI',
  descriptor,
  createAdapter: (d) => create(d),
  scenarios,
})

// --- provider-specific behaviour --------------------------------------------------

const request = (
  params: Record<string, unknown> = { prompt: 'a lighthouse at dusk' },
  model = 'core',
  task: string = MEDIA_TASK.TEXT_TO_IMAGE
) => ({
  client_job_id: '01JSTABILITYJOB000000000',
  provider_id: 'stability-ai',
  model_id: `stability-ai:${model}`,
  task,
  params,
})

describe('Stability AI — wire format', () => {
  it('posts multipart form fields to the model’s generate endpoint, asking for JSON', async () => {
    await create().submit(
      request({
        prompt: 'a lighthouse',
        aspect_ratio: '16:9',
        output_format: 'webp',
        seed: 5,
      })
    )

    const sent = state.requests.at(-1)!
    expect(sent).toMatchObject({
      method: 'POST',
      url: `${BASE}/v2beta/stable-image/generate/core`,
    })
    expect(sent.headers).toEqual({
      Accept: 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    })
    // Content-Type is left to the runtime, which adds the multipart boundary.
    expect(sent.headers).not.toHaveProperty('Content-Type')
    expect(sent.body).toEqual({
      prompt: 'a lighthouse',
      aspect_ratio: '16:9',
      output_format: 'webp',
      seed: '5',
    })
  })

  it('uploads an image-to-image starting image as a file', async () => {
    await create().submit(
      request(
        {
          prompt: 'make it winter',
          image: `data:image/png;base64,${PNG_BASE64}`,
          strength: 0.6,
        },
        'ultra',
        MEDIA_TASK.IMAGE_TO_IMAGE
      )
    )

    const body = state.requests.at(-1)!.body as Record<string, unknown>
    expect(body.image).toBeInstanceOf(Blob)
    expect((body.image as Blob).type).toBe('image/png')
    expect(body.strength).toBe('0.6')
  })

  it('refuses a starting image that is a path, before sending anything', async () => {
    await expect(
      create().submit(
        request(
          { prompt: 'x', image: 'C:\\pics\\a.png', strength: 0.5 },
          'ultra',
          MEDIA_TASK.IMAGE_TO_IMAGE
        )
      )
    ).rejects.toMatchObject({ code: 'invalid_params' })
    expect(state.requests).toHaveLength(0)
  })

  it('takes the job id from x-request-id and returns the image inline', async () => {
    const adapter = create()
    const submitted = await adapter.submit(request())

    expect(submitted).toMatchObject({
      state: 'queued',
      provider_job_id: state.requestId,
    })
    await expect(adapter.poll(submitted)).resolves.toMatchObject({
      state: 'succeeded',
      outputs: [{ kind: 'inline', base64: PNG_BASE64, mime: 'image/png' }],
    })
  })

  it('reports running while the image is still arriving, without another request', async () => {
    const body = deferred<unknown>()
    state.body = () => body.promise
    const adapter = create()
    const submitted = await adapter.submit(request())
    const calls = state.requests.length

    await expect(adapter.poll(submitted)).resolves.toMatchObject({
      state: 'running',
    })
    body.resolve(SUCCESS)
    await expect(adapter.poll(submitted)).resolves.toMatchObject({
      state: 'succeeded',
    })
    expect(state.requests).toHaveLength(calls)
  })

  it('fails a CONTENT_FILTERED generation without returning the blurred image', async () => {
    state.body = () => Promise.resolve(FILTERED)
    const adapter = create()
    const submitted = await adapter.submit(request())

    await expect(adapter.poll(submitted)).resolves.toMatchObject({
      state: 'failed',
      outputs: [],
      error: { code: 'content_filtered', retryable: false },
    })
  })

  it('fails, retryably, when the body is cut off mid-transfer', async () => {
    state.body = () => Promise.reject(new TypeError('network error'))
    const adapter = create()
    const submitted = await adapter.submit(request())

    await expect(adapter.poll(submitted)).resolves.toMatchObject({
      state: 'failed',
      error: { code: 'transport_error', retryable: true },
    })
  })
})

describe('Stability AI — errors and rate limits', () => {
  it.each([
    [400, 'bad_request', 'invalid_request', false],
    [402, 'payment_required', 'insufficient_credit', false],
    [413, 'payload_too_large', 'payload_too_large', false],
    [422, 'invalid_prompt', 'invalid_request', false],
    [429, 'rate_limit_exceeded', 'rate_limited', true],
    [500, 'internal_error', 'provider_unavailable', true],
  ] as const)('maps %s (%s) to %s', async (status, name, code, retryable) => {
    state.override = (sent) =>
      sent.method === 'POST'
        ? jsonResponse(status, { id: 'e1', name, errors: [`${name}: details`] })
        : undefined

    const error = await create()
      .submit(request())
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(StabilityAiError)
    expect(error).toMatchObject({
      status,
      code,
      retryable,
      message: `${name}: details`,
    })
  })

  it('treats a 403 content_moderation as a filtered request, not an auth failure', async () => {
    state.override = (sent) =>
      sent.method === 'POST'
        ? jsonResponse(403, {
            id: 'e2',
            name: 'content_moderation',
            errors: [
              'Your request was flagged by our content moderation system.',
            ],
          })
        : undefined

    await expect(create().submit(request())).rejects.toMatchObject({
      code: 'content_filtered',
      retryable: false,
    })
  })

  it('honours Retry-After on a 429', async () => {
    state.override = (sent) =>
      sent.method === 'POST'
        ? jsonResponse(
            429,
            {
              id: 'e3',
              name: 'rate_limit_exceeded',
              errors: ['You have exceeded the rate limit.'],
            },
            { 'retry-after': '60' }
          )
        : undefined

    await expect(create().submit(request())).rejects.toMatchObject({
      retryAfterMs: 60_000,
    })
  })

  it('reports a rejected key as unauthorised without echoing the key', async () => {
    const wrong = 'sk-WRONGkeyTHATtheUSERtyped0123456789'
    const health = await create(descriptor, async () => wrong).health()

    expect(health.state).toBe('unauthorised')
    expect(health.detail).toContain('Incorrect API key provided')
    expect(health.detail).not.toContain(wrong)
    expect(health.detail).toContain('[redacted]')
  })

  it('reports a missing key without making a request', async () => {
    const health = await create(descriptor, async () => undefined).health()

    expect(health).toMatchObject({ state: 'unauthorised' })
    expect(state.requests).toHaveLength(0)
  })

  it('reports online from the balance endpoint', async () => {
    await expect(create().health()).resolves.toEqual({
      state: 'online',
      service: 'Stability AI',
    })
    expect(state.requests.at(-1)!.url).toBe(`${BASE}/v1/user/balance`)
  })
})

describe('Stability AI — timeouts and aborts', () => {
  it('gives a synchronous generation the longer deadline when there is no caller signal', async () => {
    await create().submit(request())

    expect(state.requests.at(-1)!.signal).toBeInstanceOf(AbortSignal)
  })

  it('abandons a hung generation when the caller aborts', async () => {
    state.hang = true
    const controller = new AbortController()

    const pending = create().submit(request(), controller.signal)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('declares no cancel, because the API has none', async () => {
    const adapter = create()

    expect((await adapter.capabilities()).features?.cancel).toBe(false)
    expect(adapter.cancel).toBeUndefined()
  })
})

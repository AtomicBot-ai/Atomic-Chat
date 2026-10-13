/**
 * AUTOMATIC1111 / Forge adapter tests.
 *
 * Fixtures follow the AUTOMATIC1111 source read on 2026-10-09 -
 * `modules/api/api.py` (routes, error envelope, --api-auth), `modules/api/
 * models.py` (request and response models) and `modules/progress.py` (the
 * task-scoped progress endpoint) - and Forge's matching files. Not from
 * memory: AGENTS.md 6.2.
 *
 * The suite runs twice: against a default local server, which cannot
 * authenticate at all, and against one started with `--api-auth`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MEDIA_TASK } from '../../contract'
import type { MediaJobState, MediaProviderDescriptor } from '../../contract'
import { createA1111Adapter } from '../a1111'
import {
  describeMediaAdapterConformance,
  type ConformanceScenarios,
} from './conformance'
import {
  connectionRefused,
  decodeBody,
  deferred,
  jsonResponse,
  type RecordedRequest,
} from './httpFakes'

const BASE = 'http://127.0.0.1:7860'
const CREDENTIAL = 'radium:hunter2-not-a-real-password'

const descriptor: MediaProviderDescriptor = {
  id: 'a1111',
  label: 'AUTOMATIC1111',
  kind: 'local_worker',
  adapter: 'a1111',
  base_url: BASE,
  auth: { type: 'none' },
  enabled: true,
  origin: 'user',
}

const authedDescriptor: MediaProviderDescriptor = {
  ...descriptor,
  id: 'a1111-auth',
  auth: { type: 'api_key', setting_key: 'media.a1111-auth.api_key' },
}

// --- fixtures ------------------------------------------------------------------

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U'

const SD_MODELS = [
  {
    title: 'v1-5-pruned-emaonly.safetensors [6ce0161689]',
    model_name: 'v1-5-pruned-emaonly',
    hash: '6ce0161689',
    sha256: '6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa',
    filename: '/models/Stable-diffusion/v1-5-pruned-emaonly.safetensors',
    config: null,
  },
  {
    title: 'sd_xl_base_1.0.safetensors [31e35c80fc]',
    model_name: 'sd_xl_base_1.0',
    hash: '31e35c80fc',
    sha256: '31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b',
    filename: '/models/Stable-diffusion/sd_xl_base_1.0.safetensors',
    config: null,
  },
]

const SAMPLERS = [
  { name: 'DPM++ 2M', aliases: ['k_dpmpp_2m'], options: {} },
  {
    name: 'Euler a',
    aliases: ['k_euler_a', 'k_euler_ancestral'],
    options: { uses_ensd: 'True' },
  },
  { name: 'Euler', aliases: ['k_euler'], options: {} },
]

const txt2imgResponse = (images: string[] = [PNG_BASE64]) => ({
  images,
  parameters: { prompt: 'conformance', steps: 20 },
  info: JSON.stringify({
    seed: 1234,
    all_seeds: [1234],
    sampler_name: 'DPM++ 2M',
  }),
})

/** `handle_exception`'s envelope for an unhandled error. */
const OUT_OF_MEMORY = {
  error: 'OutOfMemoryError',
  detail: '',
  body: '',
  errors:
    'CUDA out of memory. Tried to allocate 2.00 GiB. GPU 0 has a total capacity of 8.00 GiB of which 512.00 MiB is free.',
}

/** FastAPI HTTPBasic's 401 under --api-auth. */
const BASIC_UNAUTHORISED = {
  error: 'HTTPException',
  detail: 'Incorrect username or password',
  body: '',
  errors: '401: Incorrect username or password',
}

function progressBodyFor(state: MediaJobState) {
  const base = { live_preview: null, id_live_preview: -1 }
  switch (state) {
    case 'queued':
      return {
        ...base,
        active: false,
        queued: true,
        completed: false,
        progress: null,
        eta: null,
        textinfo: 'In queue: 2/3',
      }
    case 'running':
      return {
        ...base,
        active: true,
        queued: false,
        completed: false,
        progress: 0.45,
        eta: 3.2,
        textinfo: 'Sampling step 9/20',
      }
    default:
      return {
        ...base,
        active: false,
        queued: false,
        completed: true,
        progress: null,
        eta: null,
        textinfo: 'Waiting...',
      }
  }
}

// --- mock server ------------------------------------------------------------------

type Generation = {
  taskId: string
  request: RecordedRequest
  response: ReturnType<typeof deferred<Response>>
}

type State = {
  reachable: boolean
  apiAuth: boolean
  acceptedCredential: string
  taskProgress: boolean
  nextTaskId: string
  states: MediaJobState[]
  outcome: 'success' | 'oom'
  images: string[]
  samplers: boolean
  generations: Map<string, Generation>
  requests: RecordedRequest[]
  /** Requests excluding the long-lived generation POSTs. */
  quick: RecordedRequest[]
  /** When set, the generation answers only when the test releases it. */
  holdBody: boolean
}

let state: State

function settleGeneration(final: MediaJobState) {
  if (state.holdBody) return
  for (const generation of state.generations.values()) {
    if (final === 'failed' || state.outcome === 'oom') {
      generation.response.resolve(jsonResponse(500, OUT_OF_MEMORY))
    } else {
      generation.response.resolve(
        jsonResponse(200, txt2imgResponse(state.images))
      )
    }
  }
}

function transport(input: string, init: RequestInit = {}): Promise<Response> {
  const request: RecordedRequest = {
    url: input,
    method: init.method ?? 'GET',
    headers: { ...((init.headers as Record<string, string>) ?? {}) },
    body: decodeBody(init.body),
    signal: init.signal ?? undefined,
  }
  state.requests.push(request)
  const path = input.slice(BASE.length)
  const isGeneration =
    path === '/sdapi/v1/txt2img' || path === '/sdapi/v1/img2img'
  if (!isGeneration) state.quick.push(request)

  if (!state.reachable) return Promise.reject(connectionRefused())
  if (
    state.apiAuth &&
    request.headers.Authorization !== `Basic ${btoa(state.acceptedCredential)}`
  ) {
    return Promise.resolve(
      jsonResponse(401, BASIC_UNAUTHORISED, { 'www-authenticate': 'Basic' })
    )
  }

  if (isGeneration) {
    const body = request.body as { force_task_id: string }
    const generation: Generation = {
      taskId: body.force_task_id,
      request,
      response: deferred<Response>(),
    }
    state.generations.set(body.force_task_id, generation)
    init.signal?.addEventListener('abort', () =>
      generation.response.reject(
        Object.assign(new Error('aborted'), { name: 'AbortError' })
      )
    )
    return generation.response.promise
  }
  if (path === '/sdapi/v1/sd-models')
    return Promise.resolve(jsonResponse(200, SD_MODELS))
  if (path === '/sdapi/v1/samplers') {
    return Promise.resolve(
      state.samplers
        ? jsonResponse(200, SAMPLERS)
        : jsonResponse(404, { detail: 'Not Found' })
    )
  }
  if (path === '/internal/progress') {
    if (!state.taskProgress)
      return Promise.resolve(jsonResponse(404, { detail: 'Not Found' }))
    const next =
      state.states.length > 1 ? state.states.shift()! : state.states[0]!
    if (next === 'succeeded' || next === 'failed' || next === 'cancelled')
      settleGeneration(next)
    return Promise.resolve(jsonResponse(200, progressBodyFor(next)))
  }
  if (path.startsWith('/sdapi/v1/progress')) {
    const busy = state.states[0] === 'running'
    return Promise.resolve(
      jsonResponse(200, {
        progress: busy ? 0.3 : 0,
        eta_relative: busy ? 4.1 : 0,
        state: {
          skipped: false,
          interrupted: false,
          job: '',
          job_count: busy ? 1 : 0,
          job_no: 0,
          sampling_step: 6,
          sampling_steps: 20,
        },
        current_image: null,
        textinfo: null,
      })
    )
  }
  if (path === '/sdapi/v1/interrupt')
    return Promise.resolve(jsonResponse(200, {}))
  return Promise.resolve(jsonResponse(404, { detail: 'Not Found' }))
}

beforeEach(() => {
  state = {
    reachable: true,
    apiAuth: false,
    acceptedCredential: CREDENTIAL,
    taskProgress: true,
    nextTaskId: 'task(radium-test)',
    states: ['queued'],
    outcome: 'success',
    images: [PNG_BASE64],
    samplers: true,
    generations: new Map(),
    requests: [],
    quick: [],
    holdBody: false,
  }
})

type CreateOptions = {
  d?: MediaProviderDescriptor
  resolveSecret?: () => Promise<string | undefined>
  cancelWatch?: { intervalMs: number; maxMs: number }
  completionGraceMs?: number
}

const create = ({ d = descriptor, ...rest }: CreateOptions = {}) =>
  createA1111Adapter(d, {
    fetch: transport,
    resolveSecret: rest.resolveSecret ?? (async () => CREDENTIAL),
    taskId: () => state.nextTaskId,
    cancelWatch: rest.cancelWatch,
    completionGraceMs: rest.completionGraceMs,
  })

function scenariosFor(apiAuth: boolean): ConformanceScenarios {
  return {
    online() {
      state.reachable = true
      state.apiAuth = apiAuth
      state.acceptedCredential = CREDENTIAL
    },
    unreachable() {
      state.reachable = false
    },
    unauthorised() {
      if (!apiAuth) return false
      state.reachable = true
      state.apiAuth = true
      // The saved password no longer matches the one the server was started
      // with.
      state.acceptedCredential = 'radium:changed-on-the-server'
      return true
    },
    capabilities() {
      state.reachable = true
    },
    acceptsSubmit(providerJobId) {
      state.reachable = true
      state.nextTaskId = providerJobId
    },
    jobStates(states) {
      state.states = [...states]
    },
    synchronous: () => false,
    // The generation request is long-lived and carries the job's own signal;
    // what the caller's signal must reach is every request made on its behalf.
    lastSignal: () => state.quick.at(-1)?.signal,
    callCount: () => state.requests.length,
  }
}

describeMediaAdapterConformance({
  name: 'AUTOMATIC1111',
  descriptor,
  createAdapter: (d) => create({ d }),
  scenarios: scenariosFor(false),
})

describe('with --api-auth', () => {
  beforeEach(() => {
    state.apiAuth = true
  })

  describeMediaAdapterConformance({
    name: 'AUTOMATIC1111 (--api-auth)',
    descriptor: authedDescriptor,
    createAdapter: (d) => create({ d }),
    scenarios: scenariosFor(true),
  })
})

// --- provider-specific behaviour --------------------------------------------------

const request = (
  params: Record<string, unknown> = {
    prompt: 'a castle',
    resolution: '768x512',
    steps: 25,
    guidance_scale: 6.5,
  },
  task: string = MEDIA_TASK.TEXT_TO_IMAGE
) => ({
  client_job_id: '01JA1111JOB0000000000000',
  provider_id: 'a1111',
  model_id: 'a1111:sd_xl_base_1.0',
  task,
  params,
})

describe('AUTOMATIC1111 — submit', () => {
  it('selects the checkpoint per request and sends its own task id', async () => {
    await create().submit(
      request({ ...request().params, sampler_name: 'Euler a', seed: 99 })
    )

    const generation = state.generations.get('task(radium-test)')!
    expect(generation.request.url).toBe(`${BASE}/sdapi/v1/txt2img`)
    expect(generation.request.body).toEqual({
      prompt: 'a castle',
      negative_prompt: '',
      seed: 99,
      batch_size: 1,
      n_iter: 1,
      steps: 25,
      cfg_scale: 6.5,
      sampler_name: 'Euler a',
      width: 768,
      height: 512,
      force_task_id: 'task(radium-test)',
      send_images: true,
      save_images: false,
      override_settings: { sd_model_checkpoint: 'sd_xl_base_1.0' },
      override_settings_restore_afterwards: false,
    })
    // The global options endpoint is never touched.
    expect(
      state.requests.some((r) => r.url.endsWith('/sdapi/v1/options'))
    ).toBe(false)
  })

  it('asks A1111 to randomise when no seed was resolved', async () => {
    await create().submit(request({ prompt: 'x' }))

    expect(
      state.generations.get('task(radium-test)')!.request.body
    ).toMatchObject({ seed: -1 })
  })

  it('derives a task id from the client job id by default', async () => {
    const adapter = createA1111Adapter(descriptor, { fetch: transport })

    const snapshot = await adapter.submit(request())

    expect(snapshot.provider_job_id).toBe('radium-01JA1111JOB0000000000000')
  })

  it('sends img2img with the starting image as a data URL', async () => {
    const image = `data:image/png;base64,${PNG_BASE64}`
    await create().submit(
      request(
        { prompt: 'winter', init_image: image, strength: 0.4 },
        MEDIA_TASK.IMAGE_TO_IMAGE
      )
    )

    const generation = state.generations.get('task(radium-test)')!
    expect(generation.request.url).toBe(`${BASE}/sdapi/v1/img2img`)
    expect(generation.request.body).toMatchObject({
      init_images: [image],
      denoising_strength: 0.4,
    })
  })

  it('refuses img2img without a usable starting image, before sending', async () => {
    await expect(
      create().submit(
        request(
          { prompt: 'x', init_image: '/tmp/a.png' },
          MEDIA_TASK.IMAGE_TO_IMAGE
        )
      )
    ).rejects.toMatchObject({ code: 'invalid_params' })
    expect(state.requests).toHaveLength(0)
  })

  it('throws when the server is unreachable, leaving no job behind', async () => {
    state.reachable = false
    const adapter = create()

    await expect(adapter.submit(request())).rejects.toThrow()
    await expect(
      adapter.poll({ client_job_id: request().client_job_id })
    ).rejects.toMatchObject({ code: 'unknown_job' })
  })
})

describe('AUTOMATIC1111 — progress', () => {
  it('reports running with progress and ETA from the task-scoped endpoint', async () => {
    const adapter = create()
    const job = await adapter.submit(request())
    state.states = ['running']

    await expect(adapter.poll(job)).resolves.toMatchObject({
      state: 'running',
      progress: 45,
      eta_ms: 3200,
    })
    expect(state.quick.at(-1)!.body).toEqual({
      id_task: 'task(radium-test)',
      id_live_preview: -1,
      live_preview: false,
    })
  })

  it('reports the queue position while queued', async () => {
    const adapter = create()

    await expect(adapter.submit(request())).resolves.toMatchObject({
      state: 'queued',
      queue_position: 1,
    })
  })

  it('waits briefly for the images when the task completes before they arrive', async () => {
    state.holdBody = true
    const adapter = create({ completionGraceMs: 1_000 })
    const job = await adapter.submit(request())
    state.states = ['succeeded']

    const polled = adapter.poll(job)
    setTimeout(
      () =>
        state.generations
          .get('task(radium-test)')!
          .response.resolve(jsonResponse(200, txt2imgResponse([JPEG_BASE64]))),
      10
    )

    await expect(polled).resolves.toMatchObject({
      state: 'succeeded',
      outputs: [{ kind: 'inline', base64: JPEG_BASE64, mime: 'image/jpeg' }],
    })
  })

  it('reports running, not a failure, if the images are later than the grace period', async () => {
    state.holdBody = true
    const adapter = create({ completionGraceMs: 5 })
    const job = await adapter.submit(request())
    state.states = ['succeeded']

    await expect(adapter.poll(job)).resolves.toMatchObject({
      state: 'running',
      progress: 100,
    })
  })

  it('maps running out of graphics memory to a non-retryable failure', async () => {
    state.outcome = 'oom'
    const adapter = create()
    const job = await adapter.submit(request())
    state.states = ['failed']

    await expect(adapter.poll(job)).resolves.toMatchObject({
      state: 'failed',
      outputs: [],
      error: {
        code: 'out_of_memory',
        message: expect.stringContaining('CUDA out of memory'),
        retryable: false,
      },
    })
  })

  describe('without the web UI (--nowebui)', () => {
    beforeEach(() => {
      state.taskProgress = false
    })

    it('falls back to the global progress and claims no percentage', async () => {
      const adapter = create()
      const job = await adapter.submit(request())
      state.states = ['running']

      await expect(adapter.poll(job)).resolves.toMatchObject({
        state: 'running',
        progress: null,
      })
      expect(state.quick.at(-1)!.url).toBe(
        `${BASE}/sdapi/v1/progress?skip_current_image=true`
      )
    })

    it('refuses to cancel rather than interrupting a job that may not be its own', async () => {
      const adapter = create()
      const job = await adapter.submit(request())

      await expect(adapter.cancel!(job)).rejects.toMatchObject({
        code: 'cancel_unsupported',
      })
      expect(state.requests.some((r) => r.url.endsWith('/interrupt'))).toBe(
        false
      )
    })
  })
})

describe('AUTOMATIC1111 — cancellation', () => {
  it('interrupts a running job and reports it cancelled', async () => {
    const adapter = create()
    const job = await adapter.submit(request())
    state.states = ['running']

    await adapter.cancel!(job)

    expect(state.requests.at(-1)).toMatchObject({
      method: 'POST',
      url: `${BASE}/sdapi/v1/interrupt`,
    })
    await expect(adapter.poll(job)).resolves.toMatchObject({
      state: 'cancelled',
    })
  })

  it('does not interrupt while queued, but does the moment the job starts', async () => {
    const adapter = create({ cancelWatch: { intervalMs: 5, maxMs: 5_000 } })
    const job = await adapter.submit(request())
    state.states = ['queued', 'queued', 'running']

    await adapter.cancel!(job)
    expect(state.requests.some((r) => r.url.endsWith('/interrupt'))).toBe(false)

    await vi.waitFor(() =>
      expect(state.requests.some((r) => r.url.endsWith('/interrupt'))).toBe(
        true
      )
    )
    await expect(adapter.poll(job)).resolves.toMatchObject({
      state: 'cancelled',
    })
  })

  it('stops watching once the job finishes on its own', async () => {
    const adapter = create({ cancelWatch: { intervalMs: 5, maxMs: 5_000 } })
    const job = await adapter.submit(request())
    state.states = ['queued', 'succeeded']

    await adapter.cancel!(job)
    await vi.waitFor(() => expect(state.states).toEqual(['succeeded']))
    const before = state.requests.length
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(state.requests.some((r) => r.url.endsWith('/interrupt'))).toBe(false)
    // No further probes after the job is over.
    expect(state.requests.length).toBeLessThanOrEqual(before + 1)
  })
})

describe('AUTOMATIC1111 — capabilities and auth', () => {
  it('lists checkpoints with the server’s samplers', async () => {
    const capabilities = await create().capabilities()

    expect(capabilities.models.map((m) => [m.id, m.label])).toEqual([
      [
        'a1111:v1-5-pruned-emaonly',
        'v1-5-pruned-emaonly.safetensors [6ce0161689]',
      ],
      ['a1111:sd_xl_base_1.0', 'sd_xl_base_1.0.safetensors [31e35c80fc]'],
    ])
    const sampler = capabilities.models[0]!.params[
      MEDIA_TASK.TEXT_TO_IMAGE
    ]!.find((spec) => spec.id === 'sampler_name')
    expect(sampler?.options?.map((o) => o.value)).toEqual([
      'DPM++ 2M',
      'Euler a',
      'Euler',
    ])
  })

  it('omits the sampler control when the server does not list samplers', async () => {
    state.samplers = false

    const capabilities = await create().capabilities()

    expect(
      capabilities.models[0]!.params[MEDIA_TASK.TEXT_TO_IMAGE]!.some(
        (s) => s.id === 'sampler_name'
      )
    ).toBe(false)
  })

  it('lists no models when the server is unreachable', async () => {
    state.reachable = false

    await expect(create().capabilities()).resolves.toMatchObject({ models: [] })
  })

  it('sends the --api-auth credential as HTTP Basic', async () => {
    state.apiAuth = true

    await expect(
      create({ d: authedDescriptor }).health()
    ).resolves.toMatchObject({
      state: 'online',
    })
    expect(state.requests.at(-1)!.headers.Authorization).toBe(
      `Basic ${btoa(CREDENTIAL)}`
    )
  })

  it('explains a 401 from a server started with --api-auth when no credential is saved', async () => {
    state.apiAuth = true

    const health = await create().health()

    expect(health.state).toBe('unauthorised')
    expect(health.detail).toMatch(/--api-auth/)
  })

  it('rejects a credential that is not user:password before sending it', async () => {
    const health = await create({
      d: authedDescriptor,
      resolveSecret: async () => 'just-a-token',
    }).health()

    expect(health).toMatchObject({
      state: 'unauthorised',
      detail: expect.stringMatching(/user:password/),
    })
    expect(state.requests).toHaveLength(0)
  })
})

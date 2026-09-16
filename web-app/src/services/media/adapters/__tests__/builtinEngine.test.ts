/**
 * Built-in engine adapter tests.
 *
 * The wire shapes below are the ones the engine's server returned on the laptop
 * (2026-09-15, stable-diffusion.cpp master-866-42d6c0a): a 202 with a job id,
 * then `status` moving queued -> generating -> completed with the image as
 * `result.images[].b64_json`. The Tauri side is faked; `runtime.rs` has its own
 * tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MediaJobState, MediaProviderDescriptor } from '../../contract'
import {
  createBuiltinEngineAdapter,
  engineRequestBody,
  framesFor,
  outputsOf,
  type BuiltinEngineTransport,
  type EngineStatus,
} from '../builtinEngine'
import {
  describeMediaAdapterConformance,
  type ConformanceScenarios,
} from './conformance'

const descriptor: MediaProviderDescriptor = {
  id: 'builtin-engine',
  label: 'Built-in engine',
  kind: 'local_engine',
  adapter: 'builtin-engine',
  auth: { type: 'none' },
  enabled: true,
  origin: 'builtin',
}

const STATUS: EngineStatus = {
  variant: 'windows_vulkan',
  engine_installed: true,
  engine_size_bytes: 39_092_706,
  running_model: null,
  base_url: null,
  models: [
    {
      id: 'sd-1.5',
      label: 'Stable Diffusion 1.5',
      family: 'sd1',
      tasks: ['text_to_image'],
      license: 'creativeml-openrail-m',
      license_url: 'https://huggingface.co/spaces/CompVis/stable-diffusion-license',
      min_memory_mb: 3072,
      defaults: { width: 512, height: 512, steps: 20, cfg_scale: 7, sampler: 'euler_a' },
      size_bytes: 1_763_578_176,
      installed: true,
    },
    {
      id: 'wan2.2-ti2v-5b',
      label: 'Wan 2.2 TI2V 5B',
      family: 'wan',
      tasks: ['text_to_video'],
      license: 'apache-2.0',
      license_url: 'https://www.apache.org/licenses/LICENSE-2.0',
      min_memory_mb: 12000,
      defaults: { width: 832, height: 480, steps: 30, cfg_scale: 5, sampler: 'euler' },
      size_bytes: 5_000_000_000,
      installed: false,
    },
  ],
}

const BASE_URL = 'http://127.0.0.1:41234'
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

type FakeState = {
  reachable: boolean
  jobId: string
  states: MediaJobState[]
  calls: number
  lastSignal?: AbortSignal
  invoked: Array<{ command: string; args?: Record<string, unknown> }>
  fetched: Array<{ url: string; method?: string; body?: unknown }>
  listeners: Map<string, (payload: unknown) => void>
  generating: boolean
}

let fake: FakeState

const ENGINE_STATUS_FOR: Record<MediaJobState, string> = {
  queued: 'queued',
  running: 'generating',
  succeeded: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function nextJobState(): MediaJobState {
  return fake.states.length > 1 ? (fake.states.shift() as MediaJobState) : fake.states[0]
}

const transport: BuiltinEngineTransport = {
  async invoke<T>(command: string, args?: Record<string, unknown>, signal?: AbortSignal) {
    fake.calls += 1
    fake.lastSignal = signal
    fake.invoked.push({ command, args })
    if (!fake.reachable) throw new Error('The built-in media engine has no build for this computer.')
    if (command === 'media_engine_status') return STATUS as T
    if (command === 'media_engine_start') {
      return { model_id: args?.modelId, base_url: BASE_URL } as T
    }
    if (command === 'media_engine_install') {
      fake.listeners.get(`download-${args?.taskId}`)?.({ transferred: 512, total: 1024 })
      return undefined as T
    }
    return undefined as T
  },
  async fetch(url: string, init?: RequestInit) {
    fake.calls += 1
    fake.lastSignal = init?.signal ?? undefined
    fake.fetched.push({
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    if (!fake.reachable) throw new TypeError('fetch failed')
    if (url.endsWith('/sdcpp/v1/img_gen') || url.endsWith('/sdcpp/v1/vid_gen')) {
      return json({ id: fake.jobId, kind: 'img_gen', status: 'queued', poll_url: `/sdcpp/v1/jobs/${fake.jobId}` }, 202)
    }
    if (url.endsWith(`/sdcpp/v1/jobs/${fake.jobId}/cancel`)) {
      return fake.generating
        ? json({ error: 'job is currently generating and cannot be interrupted yet' }, 409)
        : json({ status: 'cancelled' })
    }
    if (url.endsWith(`/sdcpp/v1/jobs/${fake.jobId}`)) {
      const state = nextJobState()
      return json({
        id: fake.jobId,
        status: ENGINE_STATUS_FOR[state],
        queue_position: state === 'queued' ? 1 : 0,
        error: state === 'failed' ? { message: 'out of video memory' } : null,
        result:
          state === 'succeeded'
            ? { images: [{ b64_json: PNG_BASE64, index: 0 }], output_format: 'png' }
            : null,
      })
    }
    return json({ error: 'not_found' }, 404)
  },
  async listen<T>(event: string, handler: (payload: T) => void) {
    fake.listeners.set(event, handler as (payload: unknown) => void)
    return () => fake.listeners.delete(event)
  },
}

beforeEach(() => {
  fake = {
    reachable: true,
    jobId: 'job_6aa955be_00000000',
    states: ['queued'],
    calls: 0,
    invoked: [],
    fetched: [],
    listeners: new Map(),
    generating: false,
  }
})

const scenarios: ConformanceScenarios = {
  online() {
    fake.reachable = true
  },
  unreachable() {
    fake.reachable = false
  },
  unauthorised() {
    // The engine runs on this computer with nothing to authenticate.
    return false
  },
  capabilities() {
    fake.reachable = true
  },
  acceptsSubmit(providerJobId: string) {
    fake.reachable = true
    fake.jobId = providerJobId
  },
  jobStates(states: MediaJobState[]) {
    fake.states = [...states]
  },
  lastSignal: () => fake.lastSignal,
  callCount: () => fake.calls,
}

describeMediaAdapterConformance({
  name: 'Built-in engine',
  descriptor,
  createAdapter: (d) => createBuiltinEngineAdapter(d, transport),
  scenarios,
})

describe('built-in engine specifics', () => {
  const adapter = () => createBuiltinEngineAdapter(descriptor, transport)

  it('lists every catalog model with its download state and a size to show', async () => {
    const capabilities = await adapter().capabilities()

    expect(capabilities.models.map((m) => m.id)).toEqual([
      'builtin-engine:sd-1.5',
      'builtin-engine:wan2.2-ti2v-5b',
    ])
    expect(capabilities.models[0].install).toMatchObject({ installed: true, installable: true })
    expect(capabilities.models[1].install).toMatchObject({ installed: false, installable: true })
    expect(capabilities.features?.install).toBe(true)
    expect(capabilities.recommended).toEqual([
      { task: 'text_to_image', model_id: 'builtin-engine:sd-1.5' },
    ])
  })

  it('offers the model default size first, then the family sizes', async () => {
    const sd = (await adapter().capabilities()).models[0]
    const resolution = sd.params.text_to_image.find((p) => p.id === 'resolution')

    expect(resolution?.default).toBe('512x512')
    expect(resolution?.options?.map((o) => o.value)).toEqual(['512x512', '512x768', '768x512'])
  })

  it('gives video models frames and FPS, and image models neither', async () => {
    const [image, video] = (await adapter().capabilities()).models
    const ids = (specs: { id: string }[]) => specs.map((s) => s.id)

    expect(ids(video.params.text_to_video)).toEqual(
      expect.arrayContaining(['length_seconds', 'fps', 'init_image', 'end_image'])
    )
    expect(ids(image.params.text_to_image)).not.toContain('length_seconds')
    expect(ids(image.params.text_to_image)).toEqual(
      expect.arrayContaining(['init_image', 'strength'])
    )
  })

  it('starts the model the job needs, then sends the job to the engine', async () => {
    const instance = adapter()
    await instance.submit({
      client_job_id: 'c1',
      provider_id: 'builtin-engine',
      model_id: 'builtin-engine:sd-1.5',
      task: 'text_to_image',
      params: { prompt: 'a red apple', resolution: '512x768', steps: 12, guidance_scale: 6.5 },
    })

    expect(fake.invoked.find((c) => c.command === 'media_engine_start')?.args).toEqual({
      modelId: 'sd-1.5',
    })
    expect(fake.fetched[0]).toMatchObject({
      url: `${BASE_URL}/sdcpp/v1/img_gen`,
      method: 'POST',
      body: {
        prompt: 'a red apple',
        width: 512,
        height: 768,
        // The engine's own settings shape: steps and guidance under sample_params.
        sample_params: { sample_steps: 12, guidance: { txt_cfg: 6.5 } },
        seed: -1,
        batch_count: 1,
      },
    })
  })

  it('returns the finished image inline, as the engine sent it', async () => {
    const instance = adapter()
    const submitted = await instance.submit({
      client_job_id: 'c2',
      provider_id: 'builtin-engine',
      model_id: 'builtin-engine:sd-1.5',
      task: 'text_to_image',
      params: { prompt: 'x' },
    })
    fake.states = ['succeeded']

    const done = await instance.poll(submitted)

    expect(done.state).toBe('succeeded')
    expect(done.outputs).toEqual([{ kind: 'inline', base64: PNG_BASE64, mime: 'image/png' }])
  })

  it('reports a job the engine forgot as failed, not retryable', async () => {
    const instance = adapter()
    const submitted = await instance.submit({
      client_job_id: 'c3',
      provider_id: 'builtin-engine',
      model_id: 'builtin-engine:sd-1.5',
      task: 'text_to_image',
      params: { prompt: 'x' },
    })
    fake.jobId = 'someone-else'

    const snapshot = await instance.poll(submitted)

    expect(snapshot.state).toBe('failed')
    expect(snapshot.error).toMatchObject({ code: 'job_unknown', retryable: false })
  })

  it('installs through Radium, reporting download progress', async () => {
    const onProgress = vi.fn()

    await adapter().install!('builtin-engine:sd-1.5', onProgress)

    expect(fake.invoked.find((c) => c.command === 'media_engine_install')?.args).toEqual({
      modelId: 'sd-1.5',
      taskId: 'media-engine-sd-1_5',
    })
    // Tauri rejects any other character in an event name.
    const taskId = String(fake.invoked.find((c) => c.command === 'media_engine_install')?.args?.taskId)
    expect(`download-${taskId}`).toMatch(/^[A-Za-z0-9_\-/:]+$/)
    expect(onProgress).toHaveBeenCalledWith({ received: 512, total: 1024 })
    // The progress listener is let go afterwards.
    expect(fake.listeners.size).toBe(0)
  })

  it('cancels a running job on the engine', async () => {
    const instance = adapter()
    const submitted = await instance.submit({
      client_job_id: 'c4',
      provider_id: 'builtin-engine',
      model_id: 'builtin-engine:sd-1.5',
      task: 'text_to_image',
      params: { prompt: 'x' },
    })

    await instance.cancel!(submitted)

    expect(fake.fetched.at(-1)).toMatchObject({
      url: `${BASE_URL}/sdcpp/v1/jobs/${fake.jobId}/cancel`,
      method: 'POST',
    })
  })
})

describe('built-in engine: what the real server does', () => {
  const adapter = () => createBuiltinEngineAdapter(descriptor, transport)

  it('says plainly that an image already being made cannot be stopped', async () => {
    const instance = adapter()
    const submitted = await instance.submit({
      client_job_id: 'c5',
      provider_id: 'builtin-engine',
      model_id: 'builtin-engine:sd-1.5',
      task: 'text_to_image',
      params: { prompt: 'x' },
    })
    fake.generating = true

    await expect(instance.cancel!(submitted)).rejects.toMatchObject({
      code: 'cancel_unavailable',
    })
  })

  it("passes on the engine's own reason when it refuses a job", async () => {
    const refusing: BuiltinEngineTransport = {
      ...transport,
      async fetch(url: string, init?: RequestInit) {
        if (url.endsWith('/sdcpp/v1/vid_gen')) {
          return json({ error: 'loaded model does not support vid_gen' }, 400)
        }
        return transport.fetch(url, init)
      },
    }

    await expect(
      createBuiltinEngineAdapter(descriptor, refusing).submit({
        client_job_id: 'c6',
        provider_id: 'builtin-engine',
        model_id: 'builtin-engine:sd-1.5',
        task: 'text_to_video',
        params: { prompt: 'waves' },
      })
    ).rejects.toThrow('loaded model does not support vid_gen')
  })
})

describe('starting images and video length (the user, 2026-09-15)', () => {
  const DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

  it('sends a starting image and how much to change it', () => {
    const body = engineRequestBody({
      client_job_id: 'i',
      provider_id: 'builtin-engine',
      model_id: 'builtin-engine:sd-1.5',
      task: 'text_to_image',
      params: { prompt: 'a cat as a painting', init_image: DATA_URL, strength: 0.4 },
    })
    expect(body).toMatchObject({ init_image: DATA_URL, strength: 0.4 })
  })

  it('leaves strength out when there is no starting image', () => {
    const body = engineRequestBody({
      client_job_id: 'j',
      provider_id: 'builtin-engine',
      model_id: 'builtin-engine:sd-1.5',
      task: 'text_to_image',
      params: { prompt: 'a cat', strength: 0.4 },
    })
    expect(body).not.toHaveProperty('strength')
    expect(body).not.toHaveProperty('init_image')
  })

  it('only shows strength once a starting image is attached', async () => {
    const image = (await createBuiltinEngineAdapter(descriptor, transport).capabilities())
      .models[0]
    const strength = image.params.text_to_image.find((spec) => spec.id === 'strength')
    expect(strength?.depends_on).toEqual([{ param: 'init_image', truthy: true }])
  })

  it('turns a video length in seconds into frames the model takes', () => {
    const body = engineRequestBody({
      client_job_id: 'v2',
      provider_id: 'builtin-engine',
      model_id: 'builtin-engine:wan',
      task: 'text_to_video',
      params: {
        prompt: 'waves',
        length_seconds: 2,
        fps: 16,
        init_image: DATA_URL,
        end_image: DATA_URL,
      },
    })
    expect(body).toMatchObject({
      video_frames: 33,
      fps: 16,
      init_image: DATA_URL,
      end_image: DATA_URL,
    })
    expect(body).not.toHaveProperty('strength')
  })

  it('always gives 4k + 1 frames, and at least 5', () => {
    expect(framesFor(1, 16)).toBe(17)
    expect(framesFor(5, 24)).toBe(121)
    expect(framesFor(0.1, 8)).toBe(5)
    for (const [seconds, fps] of [[1, 16], [3, 12], [8, 30]]) {
      expect(framesFor(seconds, fps) % 4).toBe(1)
    }
  })
})

describe('engineRequestBody and outputsOf', () => {
  it('sends video frames and FPS only for video', () => {
    const body = engineRequestBody({
      client_job_id: 'v',
      provider_id: 'builtin-engine',
      model_id: 'builtin-engine:wan',
      task: 'text_to_video',
      params: { prompt: 'waves', num_frames: 33, fps: 16, seed: 42 },
    })
    expect(body).toMatchObject({ prompt: 'waves', video_frames: 33, fps: 16, seed: 42 })
  })

  it('keeps every image of a batch and names its type', () => {
    expect(
      outputsOf({
        result: {
          output_format: 'jpg',
          images: [{ b64_json: 'AAA' }, { b64_json: 'BBB' }],
        },
      })
    ).toEqual([
      { kind: 'inline', base64: 'AAA', mime: 'image/jpeg' },
      { kind: 'inline', base64: 'BBB', mime: 'image/jpeg' },
    ])
    expect(outputsOf({ result: null })).toEqual([])
  })
})

describe('a model offered in several sizes', () => {
  const SIZED: EngineStatus = {
    ...STATUS,
    models: [
      {
        ...STATUS.models[0],
        default_quant: 'q8_0',
        quants: [
          {
            id: 'q4_0',
            label: 'Q4_0',
            note: 'Small and quick to load.',
            size_bytes: 1_566_768_416,
            installed: false,
            files: [
              {
                role: 'model',
                name: 'stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf',
                repo: 'second-state/stable-diffusion-v1-5-GGUF',
                size: 1_566_768_416,
                installed: false,
              },
            ],
          },
          {
            id: 'q8_0',
            label: 'Q8_0',
            note: 'Near full quality.',
            size_bytes: 1_763_578_176,
            installed: true,
            files: [
              {
                role: 'model',
                name: 'stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf',
                repo: 'second-state/stable-diffusion-v1-5-GGUF',
                size: 1_763_578_176,
                installed: true,
              },
            ],
          },
        ],
      },
    ],
  }
  const invoked: Array<{ command: string; args?: Record<string, unknown> }> = []
  const sizedTransport: BuiltinEngineTransport = {
    async invoke<T>(command: string, args?: Record<string, unknown>) {
      invoked.push({ command, args })
      if (command === 'media_engine_status') return SIZED as T
      return undefined as T
    },
    async fetch() {
      return json({}, 404)
    },
    async listen() {
      return () => {}
    },
  }
  const sizedAdapter = () => createBuiltinEngineAdapter(descriptor, sizedTransport)

  it('lists each size as its own model, the default size under the plain id', async () => {
    const { models, recommended } = await sizedAdapter().capabilities()

    // The default size keeps the plain id, so saved selections still find it.
    expect(models.map((model) => model.id)).toEqual([
      'builtin-engine:sd-1.5',
      'builtin-engine:sd-1.5@q4_0',
    ])
    expect(models[0]).toMatchObject({
      label: 'Stable Diffusion 1.5 · Q8_0',
      install: { installed: true, size_bytes: 1_763_578_176 },
      quant: { group_id: 'sd-1.5', group_label: 'Stable Diffusion 1.5', label: 'Q8_0', is_default: true },
    })
    expect(models[1]).toMatchObject({
      label: 'Stable Diffusion 1.5 · Q4_0',
      install: { installed: false, size_bytes: 1_566_768_416 },
      quant: { label: 'Q4_0', note: 'Small and quick to load.', is_default: false },
      min_memory_mb: 3072,
    })
    expect(models[1].download_files).toEqual([
      {
        name: 'stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf',
        role: 'model',
        size_bytes: 1_566_768_416,
        source: 'huggingface.co/second-state/stable-diffusion-v1-5-GGUF',
        installed: false,
      },
    ])
    expect(recommended).toEqual([{ task: 'text_to_image', model_id: 'builtin-engine:sd-1.5' }])
  })

  it('downloads exactly the size chosen', async () => {
    invoked.length = 0

    await sizedAdapter().install!('builtin-engine:sd-1.5@q4_0', () => {})

    expect(invoked).toContainEqual({
      command: 'media_engine_install',
      args: { modelId: 'sd-1.5@q4_0', taskId: 'media-engine-sd-1_5_q4_0' },
    })
  })
})

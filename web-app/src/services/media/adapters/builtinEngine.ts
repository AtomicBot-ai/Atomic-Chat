/**
 * The built-in media engine adapter (tracker Task 30 S06, decision D39).
 *
 * Radium runs stable-diffusion.cpp's `sd-server` itself: the Rust side
 * (`src-tauri/src/core/media/runtime.rs`) reports the engine and its models,
 * downloads the engine and a model with the download manager, and starts the
 * server privately on 127.0.0.1 for the model a job needs. Jobs then go to the
 * server's own async API. Every shape below was checked against the running
 * server on the laptop (2026-09-15, release master-866-42d6c0a):
 *
 *   POST /sdcpp/v1/img_gen | vid_gen -> 202 { id, status: 'queued' }
 *                                       400 { error: 'loaded model does not support vid_gen' }
 *   GET  /sdcpp/v1/jobs/{id}         -> { status: queued | generating | completed | failed
 *                                        | cancelled, queue_position, error,
 *                                        result: { images: [{ b64_json }], output_format } }
 *                                       404 { error: 'job not found' }
 *   POST /sdcpp/v1/jobs/{id}/cancel  -> works while queued;
 *                                       409 { error: 'job is currently generating and
 *                                             cannot be interrupted yet' }
 *
 * Request settings follow the server's own defaults shape
 * (`/sdcpp/v1/capabilities`): steps and guidance live under `sample_params`.
 *
 * Everything that crosses into Tauri or the network goes through one transport
 * object, so the conformance suite can drive this adapter without either.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'

import { MEDIA_CONTRACT_VERSION, MEDIA_TASK } from '../contract'
import type {
  MediaCapabilities,
  MediaJobHandle,
  MediaJobSnapshot,
  MediaJobState,
  MediaModelDescriptor,
  MediaOutputRef,
  MediaParamOption,
  MediaParamSpec,
  MediaProviderAdapter,
  MediaProviderDescriptor,
  MediaProviderHealth,
  NormalizedMediaRequest,
} from '../contract'

export const BUILTIN_ENGINE_PROVIDER_ID = 'builtin-engine'

// --- what the Rust side reports ---------------------------------------------

export type EngineModelTask = 'text_to_image' | 'text_to_video'

export type EngineModelStatus = {
  id: string
  label: string
  family: string
  tasks: EngineModelTask[]
  license: string
  license_url: string
  min_memory_mb: number
  defaults: {
    width: number
    height: number
    steps: number
    cfg_scale: number
    sampler: string
  }
  /** The default size's download, and whether it is complete. */
  size_bytes: number
  installed: boolean
  /** The size used when none is chosen. */
  default_quant?: string
  /** Every size offered, smallest first. */
  quants?: EngineQuantStatus[]
}

export type EngineFileStatus = {
  role: string
  name: string
  repo: string
  size: number
  installed: boolean
}

export type EngineQuantStatus = {
  id: string
  label: string
  note: string
  size_bytes: number
  installed: boolean
  files: EngineFileStatus[]
}

export type EngineStatus = {
  variant: string
  engine_installed: boolean
  engine_size_bytes: number
  models: EngineModelStatus[]
  running_model: string | null
  base_url: string | null
}

type StartedEngine = { model_id: string; base_url: string }

// --- what the engine's server reports ---------------------------------------

type EngineJobStatus = 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled'

export type EngineJob = {
  id?: string
  status?: EngineJobStatus | string
  queue_position?: number | null
  error?: string | { message?: string; error?: string } | null
  result?: {
    output_format?: string
    [key: string]: unknown
  } | null
  started?: number | null
  completed?: number | null
}

// --- transport --------------------------------------------------------------

export type BuiltinEngineTransport = {
  invoke<T>(
    command: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T>
  fetch(url: string, init?: RequestInit): Promise<Response>
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>
}

/** The real transport: Tauri commands and events, and the engine over HTTP. */
export const tauriEngineTransport: BuiltinEngineTransport = {
  async invoke<T>(command: string, args?: Record<string, unknown>, signal?: AbortSignal) {
    // A Tauri command cannot be aborted once sent; a caller that has already
    // given up is still honoured before sending.
    signal?.throwIfAborted()
    return tauriInvoke<T>(command, args)
  },
  fetch: (url, init) => fetch(url, init),
  async listen<T>(event: string, handler: (payload: T) => void) {
    return tauriListen<T>(event, (message) => handler(message.payload))
  },
}

// --- helpers ----------------------------------------------------------------

const JOB_STATE: Record<EngineJobStatus, MediaJobState> = {
  queued: 'queued',
  generating: 'running',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
}

/** Pictures the engine takes as a starting image or a frame. */
const IMAGE_ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp']

/** Video length choices, in seconds (the user, 2026-09-15: "length etc"). */
const LENGTH_SECONDS = [1, 2, 3, 4, 5, 8]

/**
 * Frames for a video of `seconds` at `fps`. Wan wants 4k + 1 frames, so the
 * count is rounded to the nearest such number, and never below 5.
 */
export function framesFor(seconds: number, fps: number): number {
  const k = Math.max(1, Math.round((seconds * fps - 1) / 4))
  return 4 * k + 1
}

const isDataUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('data:')

/** Extra sizes offered per model family, after the model's own default. */
const FAMILY_SIZES: Record<string, Array<[number, number]>> = {
  sd1: [
    [512, 512],
    [512, 768],
    [768, 512],
  ],
  sdxl: [
    [1024, 1024],
    [832, 1216],
    [1216, 832],
  ],
  flux: [
    [1024, 1024],
    [832, 1216],
    [1216, 832],
  ],
}

export class BuiltinEngineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'BuiltinEngineError'
  }
}

function detailOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function localIdOf(modelId: string, providerId: string): string {
  const prefix = `${providerId}:`
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId
}

/** The server puts its reason in `error`, as text or an object. */
function reasonOf(body: { error?: unknown; message?: unknown } | undefined): string | undefined {
  if (!body) return undefined
  if (typeof body.error === 'string' && body.error) return body.error
  if (body.error && typeof body.error === 'object') {
    const nested = body.error as { message?: unknown; error?: unknown }
    if (typeof nested.message === 'string' && nested.message) return nested.message
    if (typeof nested.error === 'string' && nested.error) return nested.error
  }
  if (typeof body.message === 'string' && body.message) return body.message
  return undefined
}

function resolutionSpec(model: EngineModelStatus): MediaParamSpec {
  const sizes: Array<[number, number]> = [
    [model.defaults.width, model.defaults.height],
    ...(FAMILY_SIZES[model.family] ?? []),
  ]
  const seen = new Set<string>()
  const options: MediaParamOption[] = []
  for (const [width, height] of sizes) {
    const value = `${width}x${height}`
    if (seen.has(value)) continue
    seen.add(value)
    options.push({ value, label: `${width} × ${height}`, width, height })
  }
  return {
    id: 'resolution',
    type: 'resolution',
    group: 'output',
    label: 'Resolution',
    default: `${model.defaults.width}x${model.defaults.height}`,
    options,
  }
}

function paramsFor(model: EngineModelStatus, task: EngineModelTask): MediaParamSpec[] {
  const specs: MediaParamSpec[] = [
    { id: 'prompt', type: 'text', group: 'core', label: 'Prompt', required: true },
    { id: 'negative_prompt', type: 'text', group: 'core', label: 'Negative prompt' },
    // Added beside the prompt (Add file); the engine takes it as a data URL.
    task === 'text_to_video'
      ? {
          id: 'init_image',
          type: 'image_ref',
          group: 'core',
          label: 'First frame',
          accept: IMAGE_ACCEPT,
          help: 'Optional: the picture the video starts from.',
        }
      : {
          id: 'init_image',
          type: 'image_ref',
          group: 'core',
          label: 'Starting image',
          accept: IMAGE_ACCEPT,
          help: 'Optional: a picture to change so it matches the prompt.',
        },
    resolutionSpec(model),
    {
      id: 'steps',
      type: 'int',
      group: 'sampling',
      label: 'Steps',
      min: 1,
      max: 150,
      default: model.defaults.steps,
    },
    {
      id: 'guidance_scale',
      type: 'float',
      group: 'sampling',
      label: 'Guidance',
      min: 0,
      max: 30,
      step: 0.1,
      default: model.defaults.cfg_scale,
    },
  ]
  if (task === 'text_to_image') {
    specs.push({
      id: 'strength',
      type: 'float',
      group: 'core',
      label: 'How much to change it',
      help: 'Low keeps the starting image; high follows the prompt more.',
      min: 0.05,
      max: 1,
      step: 0.05,
      default: 0.75,
      widget: 'slider',
      depends_on: [{ param: 'init_image', truthy: true }],
    })
  }
  if (task === 'text_to_video') {
    specs.push(
      {
        id: 'end_image',
        type: 'image_ref',
        group: 'core',
        label: 'Last frame',
        accept: IMAGE_ACCEPT,
        help: 'Optional: the picture the video ends on.',
      },
      {
        id: 'length_seconds',
        type: 'enum',
        group: 'motion',
        label: 'Length',
        options: LENGTH_SECONDS.map((seconds) => ({
          value: seconds,
          label: seconds === 1 ? '1 second' : `${seconds} seconds`,
        })),
        default: 2,
      },
      { id: 'fps', type: 'int', group: 'motion', label: 'FPS', min: 1, max: 30, default: 16 }
    )
  }
  specs.push({ id: 'seed', type: 'seed', group: 'advanced', label: 'Seed', advanced: true })
  return specs.map((spec, index) => ({ ...spec, order: index }))
}

/** Memory a download of this size needs, roughly: its weights plus room to work. */
function memoryFor(model: EngineModelStatus, sizeBytes: number): number {
  return Math.max(model.min_memory_mb, Math.ceil((sizeBytes * 1.2) / (1024 * 1024)))
}

/**
 * One descriptor per size of each model. The default size keeps the plain
 * model id, so a saved selection and earlier jobs still find it; another size
 * is `<model>@<size>`, which the Rust side resolves the same way.
 */
function modelDescriptors(
  model: EngineModelStatus,
  providerId: string
): MediaModelDescriptor[] {
  const tasks = model.tasks.filter(
    (task) => task === MEDIA_TASK.TEXT_TO_IMAGE || task === MEDIA_TASK.TEXT_TO_VIDEO
  )
  const shared = (localId: string) => ({
    id: `${providerId}:${localId}`,
    provider_id: providerId,
    local_id: localId,
    family: model.family,
    tasks,
    params: Object.fromEntries(tasks.map((task) => [task, paramsFor(model, task)])),
    license: { id: model.license, url: model.license_url },
    outputs: Object.fromEntries(
      tasks.map((task) => [
        task,
        task === MEDIA_TASK.TEXT_TO_VIDEO
          ? { media_type: 'video' as const }
          : { media_type: 'image' as const, mime: ['image/png'] },
      ])
    ),
  })
  const quants = model.quants ?? []
  if (quants.length === 0) {
    return [
      {
        ...shared(model.id),
        label: model.label,
        install: {
          installed: model.installed,
          installable: true,
          size_bytes: model.size_bytes,
          source: { kind: 'provider' },
        },
        min_memory_mb: model.min_memory_mb,
      },
    ]
  }
  const standard = quants.find((quant) => quant.id === model.default_quant) ?? quants[0]
  // The default size first, so a page falling back to the first model gets it.
  const ordered = [standard, ...quants.filter((quant) => quant !== standard)]
  return ordered.map((quant) => {
    const isDefault = quant === standard
    return {
      ...shared(isDefault ? model.id : `${model.id}@${quant.id}`),
      label: `${model.label} · ${quant.label}`,
      install: {
        installed: quant.installed,
        installable: true,
        size_bytes: quant.size_bytes,
        source: { kind: 'provider' },
      },
      quant: {
        group_id: model.id,
        group_label: model.label,
        label: quant.label,
        note: quant.note,
        is_default: isDefault,
      },
      download_files: quant.files.map((file) => ({
        name: file.name,
        role: file.role,
        size_bytes: file.size,
        source: `huggingface.co/${file.repo}`,
        installed: file.installed,
      })),
      min_memory_mb: memoryFor(model, quant.size_bytes),
    }
  })
}

/** The body the engine's server takes for one job. */
export function engineRequestBody(req: NormalizedMediaRequest): Record<string, unknown> {
  const params = req.params
  const body: Record<string, unknown> = {
    prompt: String(params.prompt ?? ''),
    batch_count: 1,
  }
  if (typeof params.negative_prompt === 'string' && params.negative_prompt.trim()) {
    body.negative_prompt = params.negative_prompt
  }
  const resolution = typeof params.resolution === 'string' ? params.resolution : ''
  const [width, height] = resolution.split('x').map(Number)
  if (width > 0 && height > 0) {
    body.width = width
    body.height = height
  }
  const sampleParams: Record<string, unknown> = {}
  if (typeof params.steps === 'number') sampleParams.sample_steps = params.steps
  if (typeof params.guidance_scale === 'number') {
    sampleParams.guidance = { txt_cfg: params.guidance_scale }
  }
  if (Object.keys(sampleParams).length > 0) body.sample_params = sampleParams
  // An empty seed means "surprise me", which the engine spells -1.
  body.seed = typeof params.seed === 'number' ? params.seed : -1
  if (isDataUrl(params.init_image)) {
    body.init_image = params.init_image
    if (req.task !== MEDIA_TASK.TEXT_TO_VIDEO && typeof params.strength === 'number') {
      body.strength = params.strength
    }
  }
  if (req.task === MEDIA_TASK.TEXT_TO_VIDEO) {
    if (isDataUrl(params.end_image)) body.end_image = params.end_image
    const fps = typeof params.fps === 'number' ? params.fps : 16
    body.fps = fps
    const seconds = Number(params.length_seconds)
    if (Number.isFinite(seconds) && seconds > 0) {
      body.video_frames = framesFor(seconds, fps)
    } else if (typeof params.num_frames === 'number') {
      body.video_frames = params.num_frames
    }
  }
  return body
}

/** Every base64 payload in a finished job, in order, as inline outputs. */
export function outputsOf(job: EngineJob): MediaOutputRef[] {
  const result = job.result
  if (!result) return []
  const format = String(result.output_format ?? 'png').toLowerCase()
  const mime = MIME[format] ?? 'application/octet-stream'
  const outputs: MediaOutputRef[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (typeof record.b64_json === 'string' && record.b64_json) {
        outputs.push({ kind: 'inline', base64: record.b64_json, mime })
        return
      }
      Object.values(record).forEach(walk)
    }
  }
  walk(result)
  return outputs
}

// --- adapter ----------------------------------------------------------------

export function createBuiltinEngineAdapter(
  descriptor: MediaProviderDescriptor,
  transport: BuiltinEngineTransport = tauriEngineTransport
): MediaProviderAdapter {
  const providerId = descriptor.id
  /** Where each job was sent, so polling finds it again. */
  const jobBaseUrls = new Map<string, string>()

  async function baseUrlFor(providerJobId: string, signal?: AbortSignal): Promise<string> {
    const known = jobBaseUrls.get(providerJobId)
    if (known) return known
    // Radium was reloaded while a job ran: the engine may still be running it.
    const status = await transport.invoke<EngineStatus>('media_engine_status', undefined, signal)
    if (!status.base_url) {
      throw new BuiltinEngineError('The media engine is not running any more.', 'engine_stopped')
    }
    return status.base_url
  }

  function snapshot(
    handle: MediaJobHandle,
    providerJobId: string,
    state: MediaJobState,
    extra: Partial<MediaJobSnapshot> = {}
  ): MediaJobSnapshot {
    return {
      client_job_id: handle.client_job_id,
      provider_job_id: providerJobId,
      provider_id: providerId,
      state,
      ...extra,
    }
  }

  async function poll(handle: MediaJobHandle, signal?: AbortSignal): Promise<MediaJobSnapshot> {
    const providerJobId = handle.provider_job_id
    if (!providerJobId) {
      throw new BuiltinEngineError(
        `No engine job is known for "${handle.client_job_id}".`,
        'unknown_job'
      )
    }
    const baseUrl = await baseUrlFor(providerJobId, signal)
    const response = await transport.fetch(`${baseUrl}/sdcpp/v1/jobs/${providerJobId}`, { signal })
    if (response.status === 404) {
      return snapshot(handle, providerJobId, 'failed', {
        outputs: [],
        error: {
          code: 'job_unknown',
          message: 'The media engine has no record of this job. It may have been restarted.',
          retryable: false,
        },
      })
    }
    if (!response.ok) {
      throw new BuiltinEngineError(
        `The media engine answered ${response.status} for this job.`,
        'poll_failed',
        response.status
      )
    }
    const job = (await response.json()) as EngineJob
    const state = JOB_STATE[job.status as EngineJobStatus] ?? 'running'
    if (state === 'failed') {
      return snapshot(handle, providerJobId, 'failed', {
        outputs: [],
        error: {
          code: 'engine_failed',
          message: reasonOf(job) ?? 'The media engine could not make this.',
          retryable: true,
        },
      })
    }
    return snapshot(handle, providerJobId, state, {
      queue_position: job.queue_position ?? null,
      ...(state === 'succeeded' ? { outputs: outputsOf(job) } : {}),
      ...(job.started ? { started_at: job.started * 1000 } : {}),
      ...(job.completed ? { finished_at: job.completed * 1000 } : {}),
    })
  }

  return {
    descriptor,

    async health(signal?: AbortSignal): Promise<MediaProviderHealth> {
      try {
        const status = await transport.invoke<EngineStatus>('media_engine_status', undefined, signal)
        return { state: 'online', service: 'stable-diffusion.cpp', version: status.variant }
      } catch (error) {
        return { state: 'offline', detail: detailOf(error) }
      }
    },

    async capabilities(signal?: AbortSignal): Promise<MediaCapabilities> {
      const status = await transport.invoke<EngineStatus>('media_engine_status', undefined, signal)
      const models = status.models.flatMap((model) => modelDescriptors(model, providerId))
      const taskIds = [...new Set(models.flatMap((model) => model.tasks))]
      return {
        contract_version: MEDIA_CONTRACT_VERSION,
        provider_id: providerId,
        devices: [{ id: status.variant, label: status.variant, backend: status.variant }],
        models,
        tasks: taskIds.map((task) => ({
          id: task,
          label_key: `media:task.${task}`,
          output_media_type: task === MEDIA_TASK.TEXT_TO_VIDEO ? 'video' : 'image',
        })),
        recommended: models.some((model) => model.local_id === 'sd-1.5')
          ? [{ task: MEDIA_TASK.TEXT_TO_IMAGE, model_id: `${providerId}:sd-1.5` }]
          : [],
        features: {
          // Waiting jobs can be cancelled; one already generating cannot yet.
          cancel: true,
          progress: true,
          queue: true,
          events: false,
          install: true,
          batch: false,
        },
      }
    },

    async submit(req: NormalizedMediaRequest, signal?: AbortSignal): Promise<MediaJobSnapshot> {
      const localId = localIdOf(req.model_id, providerId)
      // Loads the model the first time, which can take a while; a later job for
      // the same model returns straight away.
      const started = await transport.invoke<StartedEngine>(
        'media_engine_start',
        { modelId: localId },
        signal
      )
      const route = req.task === MEDIA_TASK.TEXT_TO_VIDEO ? 'vid_gen' : 'img_gen'
      const response = await transport.fetch(`${started.base_url}/sdcpp/v1/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(engineRequestBody(req)),
        signal,
      })
      const body = (await response.json().catch(() => ({}))) as EngineJob & { message?: string }
      if (!response.ok || !body.id) {
        throw new BuiltinEngineError(
          reasonOf(body) ?? `The media engine refused the job (${response.status}).`,
          'submit_rejected',
          response.status
        )
      }
      jobBaseUrls.set(body.id, started.base_url)
      return snapshot(req, body.id, JOB_STATE[body.status as EngineJobStatus] ?? 'queued', {
        queue_position: body.queue_position ?? null,
      })
    },

    poll,

    async cancel(handle: MediaJobHandle): Promise<void> {
      const providerJobId = handle.provider_job_id
      if (!providerJobId) return
      const baseUrl = await baseUrlFor(providerJobId)
      const response = await transport.fetch(`${baseUrl}/sdcpp/v1/jobs/${providerJobId}/cancel`, {
        method: 'POST',
      })
      if (response.status === 409) {
        throw new BuiltinEngineError(
          'The engine cannot stop an image it has already started. It will finish shortly.',
          'cancel_unavailable',
          409
        )
      }
      if (!response.ok && response.status !== 404) {
        const body = (await response.json().catch(() => undefined)) as
          | { error?: unknown }
          | undefined
        throw new BuiltinEngineError(
          reasonOf(body) ?? `The media engine could not cancel this job (${response.status}).`,
          'cancel_failed',
          response.status
        )
      }
    },

    async install(modelId, onProgress, signal) {
      const localId = localIdOf(modelId, providerId)
      // Tauri event names allow only letters, digits, `-`, `/`, `:` and `_`.
      // "sd-1.5" put a dot in `download-<task id>`, so listening threw at once
      // and the download never started (found 2026-09-15).
      const taskId = `media-engine-${localId.replace(/[^A-Za-z0-9_-]/g, '_')}`
      const unlisten = await transport.listen<{ transferred: number; total: number }>(
        `download-${taskId}`,
        (progress) => onProgress({ received: progress.transferred, total: progress.total })
      )
      const onAbort = () => {
        void transport.invoke('cancel_download_task', { taskId })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await transport.invoke('media_engine_install', { modelId: localId, taskId }, signal)
      } finally {
        signal?.removeEventListener('abort', onAbort)
        unlisten()
      }
    },
  }
}

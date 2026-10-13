/**
 * The AUTOMATIC1111 / Forge adapter.
 *
 * A1111's generation endpoints (`/sdapi/v1/txt2img`, `/img2img`) hold the HTTP
 * request open until the images are done and return them in the response. But
 * unlike a cloud synchronous API it *can* be asked about a job while that
 * request is open: a request may carry its own task id (`force_task_id`), and
 * `POST /internal/progress` reports whether that task is queued, active or
 * completed, with its progress and ETA. So this adapter is job-based, with
 * one twist - the result arrives on the generation request, not from a poll.
 *
 * - `submit` sends the generation request with a task id it chose, leaves it
 *   in flight, then asks the progress endpoint about that id. That answer is
 *   the initial state, and it doubles as the proof the server is reachable.
 * - `poll` asks the progress endpoint (`queued` / `running` with progress) and
 *   reports the outcome once the generation request has answered.
 * - `cancel` interrupts only when the task is the one running. A1111's
 *   interrupt is global, and there is no way to remove a queued task, so a
 *   queued job is watched and interrupted when it starts.
 *
 * ## Recorded surface
 *
 * Read 2026-10-09 from the AUTOMATIC1111 source (`modules/api/api.py`,
 * `modules/api/models.py`, `modules/progress.py`, `webui.py`) and Forge's
 * equivalents - not from memory (AGENTS.md 6.2).
 *
 * - txt2img/img2img accept `force_task_id`, `override_settings`,
 *   `override_settings_restore_afterwards`, `send_images`, `save_images`, and
 *   return `{ images: [base64], parameters, info }`. `init_images` accepts
 *   data URLs.
 * - `POST /internal/progress { id_task, id_live_preview, live_preview }` ->
 *   `{ active, queued, completed, progress (0-1), eta (s), textinfo }`;
 *   `textinfo` is `"In queue: n/m"` while queued. Registered only when the web
 *   UI runs: with `--nowebui` it is a 404, and the adapter falls back to the
 *   global `GET /sdapi/v1/progress`, which cannot say whose job is running.
 * - `POST /sdapi/v1/interrupt` stops whatever is running.
 * - `GET /sdapi/v1/sd-models` -> `[{ title, model_name, hash, sha256,
 *   filename, config }]`; `GET /sdapi/v1/samplers` -> `[{ name, aliases }]`.
 * - Errors are `{ error, detail, body, errors }`. With `--api-auth user:pass`
 *   every API route requires HTTP Basic and answers 401 without it.
 *
 * ## Choosing the checkpoint
 *
 * Per request, through `override_settings.sd_model_checkpoint`, not by POSTing
 * `/sdapi/v1/options` first. The options call changes the server's global
 * state, races with any other client, and is a second request that can fail on
 * its own. `override_settings_restore_afterwards` is false because restoring
 * the checkpoint means loading the previous model again after every job.
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
  jobErrorFrom,
  localModelId,
  mimeFromBase64,
  readJson,
  redactCredentials,
  resolveCredential,
  signalWithDeadline,
  snapshotFor,
  type MediaHttpAdapterOptions,
} from './http'
import { NEGATIVE_PROMPT, PROMPT, sdStepsSpec } from './sharedParams'

export class A1111Error extends MediaHttpError {
  constructor(
    message: string,
    code: string,
    status?: number,
    retryable = false
  ) {
    super(message, code, status, retryable)
    this.name = 'A1111Error'
  }
}

export type A1111AdapterOptions = MediaHttpAdapterOptions & {
  /** The task id sent as `force_task_id`. Injectable for tests. */
  taskId?: (req: NormalizedMediaRequest) => string
  /**
   * How a cancelled job that was still queued is watched, so it can be
   * interrupted the moment it starts.
   */
  cancelWatch?: { intervalMs: number; maxMs: number }
  /**
   * How long a poll waits for the images once the server reports the task
   * completed. A1111 marks the task finished before it encodes the images,
   * so the response trails the progress endpoint slightly.
   */
  completionGraceMs?: number
}

export const A1111_DEFAULT_BASE_URL = 'http://127.0.0.1:7860'

const DEFAULT_CANCEL_WATCH = { intervalMs: 1_000, maxMs: 30 * 60_000 }
const DEFAULT_COMPLETION_GRACE_MS = 2_000

// --- wire types --------------------------------------------------------------

type A1111Model = { title?: string; model_name?: string }
type A1111Sampler = { name?: string }
type A1111ImagesResponse = { images?: unknown; info?: unknown }

type TaskProgress = {
  kind: 'task'
  active: boolean
  queued: boolean
  completed: boolean
  progress?: number | null
  eta?: number | null
  textinfo?: string | null
}
/** `--nowebui`: only the server-wide progress exists. */
type GlobalProgress = { kind: 'global'; busy: boolean }
type Progress = TaskProgress | GlobalProgress

// --- declared parameters -----------------------------------------------------

const RESOLUTIONS: Array<[number, number]> = [
  [512, 512],
  [512, 768],
  [768, 512],
  [768, 768],
  [1024, 1024],
  [832, 1216],
  [1216, 832],
  [896, 1152],
  [1152, 896],
  [768, 1344],
  [1344, 768],
]

function generationParams(samplers: string[]): MediaParamSpec[] {
  const specs: MediaParamSpec[] = [
    PROMPT,
    NEGATIVE_PROMPT,
    {
      id: 'resolution',
      type: 'resolution',
      label: 'Resolution',
      group: 'output',
      order: 1,
      options: RESOLUTIONS.map(([width, height]) => ({
        value: `${width}x${height}`,
        label: `${width} × ${height}`,
        width,
        height,
      })),
      // A1111's own API default.
      default: '512x512',
    },
    {
      id: 'batch_size',
      type: 'int',
      label: 'Images',
      group: 'output',
      order: 2,
      min: 1,
      max: 8,
      default: 1,
    },
    {
      ...sdStepsSpec(20),
      order: 1,
    },
    {
      id: 'guidance_scale',
      type: 'float',
      label: 'Guidance',
      group: 'sampling',
      order: 2,
      min: 1,
      max: 30,
      step: 0.5,
      default: 7,
    },
    {
      id: 'seed',
      type: 'seed',
      label: 'Seed',
      group: 'sampling',
      order: 4,
    },
  ]
  // Only offered when the server listed its samplers; otherwise it uses its
  // own default rather than one this adapter guessed.
  if (samplers.length) {
    specs.push({
      id: 'sampler_name',
      type: 'enum',
      label: 'Sampler',
      group: 'sampling',
      order: 3,
      options: samplers.map((value) => ({ value })),
      advanced: true,
    })
  }
  return specs
}

function modelsFrom(
  providerId: string,
  checkpoints: A1111Model[],
  samplers: string[]
): MediaModelDescriptor[] {
  const params = generationParams(samplers)
  const imageToImage: MediaParamSpec[] = [
    ...params,
    {
      id: 'init_image',
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
      help: 'Low keeps the starting image; high follows the prompt more.',
      group: 'core',
      order: 4,
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.75,
      widget: 'slider',
    },
  ]

  return checkpoints
    .filter(
      (model): model is { title?: string; model_name: string } =>
        typeof model.model_name === 'string' && model.model_name.length > 0
    )
    .map((model) => ({
      id: `${providerId}:${model.model_name}`,
      provider_id: providerId,
      local_id: model.model_name,
      label: model.title ?? model.model_name,
      tasks: [MEDIA_TASK.TEXT_TO_IMAGE, MEDIA_TASK.IMAGE_TO_IMAGE],
      params: {
        [MEDIA_TASK.TEXT_TO_IMAGE]: params,
        [MEDIA_TASK.IMAGE_TO_IMAGE]: imageToImage,
      },
      outputs: {
        [MEDIA_TASK.TEXT_TO_IMAGE]: { media_type: 'image' },
        [MEDIA_TASK.IMAGE_TO_IMAGE]: { media_type: 'image' },
      },
      install: { installed: true, installable: false },
    }))
}

/** `"In queue: 3/5"` -> 2 requests ahead. */
function queuePositionFrom(textinfo: string | null | undefined): number | null {
  const match = textinfo ? /In queue:\s*(\d+)\s*\/\s*\d+/i.exec(textinfo) : null
  return match ? Math.max(0, Number(match[1]) - 1) : null
}

function encodeBasic(credential: string): string {
  const bytes = new TextEncoder().encode(credential)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** One generation: the open request, and what it settled to. */
type Job = {
  taskId: string
  controller: AbortController
  done: Promise<void>
  outcome?:
    | { kind: 'resolved'; payload: A1111ImagesResponse | undefined }
    | { kind: 'rejected'; reason: unknown }
  settled?: MediaJobSnapshot
  cancelled: boolean
  watch?: ReturnType<typeof setTimeout>
}

export function createA1111Adapter(
  descriptor: MediaProviderDescriptor,
  options: A1111AdapterOptions = {}
): MediaProviderAdapter {
  const base = baseUrlOf(descriptor, A1111_DEFAULT_BASE_URL)
  const transport = options.fetch ?? globalTransport
  const taskIdFor =
    options.taskId ??
    ((req: NormalizedMediaRequest) => `radium-${req.client_job_id}`)
  const cancelWatch = options.cancelWatch ?? DEFAULT_CANCEL_WATCH
  const completionGraceMs =
    options.completionGraceMs ?? DEFAULT_COMPLETION_GRACE_MS
  const jobs = new Map<string, Job>()
  /** Whether this server has the task-scoped progress endpoint. */
  let taskProgress: 'unknown' | 'supported' | 'unsupported' = 'unknown'

  /**
   * `--api-auth` is HTTP Basic, so the stored credential is `user:password`.
   * A server started without it needs nothing, which is the default.
   */
  async function headers(json = false): Promise<Record<string, string>> {
    const credential = await resolveCredential(
      descriptor,
      options.resolveSecret
    )
    if (credential !== undefined && !credential.includes(':')) {
      throw new A1111Error(
        `Provider "${descriptor.label}" needs its credential as user:password, the form --api-auth takes.`,
        'no_api_key'
      )
    }
    return {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(credential
        ? { Authorization: `Basic ${encodeBasic(credential)}` }
        : {}),
    }
  }

  async function errorFor(
    response: Response,
    sent: Record<string, string>
  ): Promise<A1111Error> {
    const payload = await readJson(response)
    const field = (key: string) =>
      isRecord(payload) && typeof payload[key] === 'string' && payload[key]
        ? redactCredentials(payload[key] as string, sent)
        : undefined
    const name = field('error')
    const message =
      field('detail') ??
      field('errors') ??
      name ??
      `AUTOMATIC1111 answered ${response.status}.`

    if (response.status === 401) {
      return new A1111Error(
        descriptor.auth?.type && descriptor.auth.type !== 'none'
          ? `${message}. Check the user:password saved for this provider.`
          : `${message}. This server was started with --api-auth; save its user:password for this provider.`,
        'unauthorised',
        401
      )
    }
    // Running out of graphics memory is not transient: the same request on
    // the same machine will run out again.
    if (/OutOfMemory/i.test(name ?? '') || /out of memory/i.test(message)) {
      return new A1111Error(message, 'out_of_memory', response.status, false)
    }
    return new A1111Error(
      message,
      codeForStatus(response.status),
      response.status,
      isRetryableStatus(response.status)
    )
  }

  async function progressOf(
    taskId: string,
    signal?: AbortSignal
  ): Promise<Progress> {
    const auth = await headers(true)
    if (taskProgress !== 'unsupported') {
      const response = await transport(`${base}/internal/progress`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          id_task: taskId,
          id_live_preview: -1,
          live_preview: false,
        }),
        signal,
      })
      if (response.status === 404) {
        taskProgress = 'unsupported'
      } else {
        if (!response.ok) throw await errorFor(response, auth)
        taskProgress = 'supported'
        const payload = await readJson(response)
        const record = isRecord(payload) ? payload : {}
        return {
          kind: 'task',
          active: record.active === true,
          queued: record.queued === true,
          completed: record.completed === true,
          progress:
            typeof record.progress === 'number' ? record.progress : null,
          eta: typeof record.eta === 'number' ? record.eta : null,
          textinfo:
            typeof record.textinfo === 'string' ? record.textinfo : null,
        }
      }
    }

    const response = await transport(
      `${base}/sdapi/v1/progress?skip_current_image=true`,
      {
        headers: auth,
        signal,
      }
    )
    if (!response.ok) throw await errorFor(response, auth)
    const payload = await readJson(response)
    const state =
      isRecord(payload) && isRecord(payload.state) ? payload.state : {}
    return {
      kind: 'global',
      busy: typeof state.job_count === 'number' && state.job_count > 0,
    }
  }

  async function interrupt(): Promise<void> {
    const auth = await headers()
    const response = await transport(`${base}/sdapi/v1/interrupt`, {
      method: 'POST',
      headers: auth,
      signal: signalWithDeadline(undefined, MEDIA_HTTP_TIMEOUT_MS.metadata),
    })
    if (!response.ok) throw await errorFor(response, auth)
  }

  function stopWatching(job: Job) {
    if (job.watch !== undefined) clearTimeout(job.watch)
    job.watch = undefined
  }

  /** Interrupt a cancelled job when it leaves the queue, then stop. */
  function watchToInterrupt(job: Job) {
    const startedAt = Date.now()
    const tick = async () => {
      job.watch = undefined
      if (job.outcome) return
      if (Date.now() - startedAt > cancelWatch.maxMs) {
        // Given up waiting. Dropping the request does not dequeue it on the
        // server, but nothing here is listening for the result any more.
        job.controller.abort()
        return
      }
      try {
        const progress = await progressOf(
          job.taskId,
          signalWithDeadline(undefined, MEDIA_HTTP_TIMEOUT_MS.metadata)
        )
        if (progress.kind === 'task' && progress.active) {
          await interrupt()
          job.controller.abort()
          return
        }
        if (progress.kind === 'task' && progress.completed) return
      } catch {
        // Try again on the next tick; the watch is best-effort by nature.
      }
      if (!job.outcome)
        job.watch = setTimeout(() => void tick(), cancelWatch.intervalMs)
    }
    job.watch = setTimeout(() => void tick(), cancelWatch.intervalMs)
  }

  function jobFor(handle: MediaJobHandle): Job {
    const job = jobs.get(handle.client_job_id)
    if (!job) {
      throw new A1111Error(
        `No AUTOMATIC1111 generation is known for client job "${handle.client_job_id}".`,
        'unknown_job'
      )
    }
    return job
  }

  function settle(handle: MediaJobHandle, job: Job): MediaJobSnapshot {
    const finished = { finished_at: Date.now() }
    let snapshot: MediaJobSnapshot
    if (job.cancelled) {
      snapshot = snapshotFor(
        descriptor,
        handle,
        job.taskId,
        'cancelled',
        finished
      )
    } else if (!job.outcome || job.outcome.kind === 'rejected') {
      snapshot = snapshotFor(descriptor, handle, job.taskId, 'failed', {
        ...finished,
        error: jobErrorFrom(job.outcome?.reason),
      })
    } else {
      const images = Array.isArray(job.outcome.payload?.images)
        ? job.outcome.payload.images.filter(
            (image): image is string =>
              typeof image === 'string' && image.length > 0
          )
        : []
      const outputs: MediaOutputRef[] = images.map((base64) => ({
        kind: 'inline',
        base64,
        // The server's `samples_format` decides; read it from the bytes.
        mime: mimeFromBase64(base64) ?? 'image/png',
      }))
      snapshot = outputs.length
        ? snapshotFor(descriptor, handle, job.taskId, 'succeeded', {
            ...finished,
            progress: 100,
            outputs,
          })
        : snapshotFor(descriptor, handle, job.taskId, 'failed', {
            ...finished,
            error: {
              code: 'empty_response',
              message: 'AUTOMATIC1111 finished but returned no image.',
              retryable: true,
            },
          })
    }
    job.settled = snapshot
    return snapshot
  }

  function liveSnapshot(
    handle: MediaJobHandle,
    job: Job,
    progress: Progress
  ): MediaJobSnapshot {
    if (progress.kind === 'global') {
      // Something is in flight and the server cannot say whether it is this
      // job, so progress is not claimed.
      return snapshotFor(
        descriptor,
        handle,
        job.taskId,
        progress.busy ? 'running' : 'queued'
      )
    }
    if (progress.active || progress.completed) {
      return snapshotFor(descriptor, handle, job.taskId, 'running', {
        progress: progress.completed
          ? 100
          : typeof progress.progress === 'number'
            ? Math.round(progress.progress * 100)
            : null,
        eta_ms:
          typeof progress.eta === 'number'
            ? Math.round(progress.eta * 1000)
            : null,
      })
    }
    // Queued, or sent but not yet registered by the server: either way, not
    // started.
    return snapshotFor(descriptor, handle, job.taskId, 'queued', {
      queue_position: queuePositionFrom(progress.textinfo),
    })
  }

  function bodyFor(
    req: NormalizedMediaRequest,
    taskId: string
  ): {
    route: string
    body: Record<string, unknown>
  } {
    const params = req.params
    const isImageToImage = req.task === MEDIA_TASK.IMAGE_TO_IMAGE
    const [width, height] = (
      typeof params.resolution === 'string' ? params.resolution : ''
    )
      .split('x')
      .map(Number)

    const body: Record<string, unknown> = {
      prompt: params.prompt,
      negative_prompt: params.negative_prompt ?? '',
      // -1 is A1111's "random". The job manager normally resolves a seed above
      // every adapter (D8), so this is only reached without one.
      seed: typeof params.seed === 'number' ? params.seed : -1,
      batch_size: typeof params.batch_size === 'number' ? params.batch_size : 1,
      n_iter: 1,
      force_task_id: taskId,
      send_images: true,
      save_images: false,
      override_settings: {
        sd_model_checkpoint: localModelId(descriptor, req.model_id),
      },
      override_settings_restore_afterwards: false,
    }
    if (typeof params.steps === 'number') body.steps = params.steps
    if (typeof params.guidance_scale === 'number')
      body.cfg_scale = params.guidance_scale
    if (typeof params.sampler_name === 'string')
      body.sampler_name = params.sampler_name
    if (width > 0 && height > 0) {
      body.width = width
      body.height = height
    }

    if (isImageToImage) {
      if (!isDataUrl(params.init_image)) {
        throw new A1111Error(
          'Image-to-image needs a starting image, supplied as an image file.',
          'invalid_params'
        )
      }
      body.init_images = [params.init_image]
      if (typeof params.strength === 'number')
        body.denoising_strength = params.strength
    }

    return {
      route: isImageToImage ? '/sdapi/v1/img2img' : '/sdapi/v1/txt2img',
      body,
    }
  }

  return {
    descriptor,

    async health(signal?: AbortSignal): Promise<MediaProviderHealth> {
      try {
        const auth = await headers()
        const response = await transport(`${base}/sdapi/v1/sd-models`, {
          headers: auth,
          signal: signalWithDeadline(signal, MEDIA_HTTP_TIMEOUT_MS.metadata),
        })
        if (response.status === 401) {
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
        return { state: 'online', service: 'AUTOMATIC1111' }
      } catch (error) {
        if (error instanceof MediaHttpError && error.code === 'no_api_key') {
          return { state: 'unauthorised', detail: error.message }
        }
        return { state: 'offline', detail: describeFailure(error) }
      }
    },

    async capabilities(signal?: AbortSignal): Promise<MediaCapabilities> {
      let checkpoints: A1111Model[] = []
      let samplers: string[] = []
      try {
        const auth = await headers()
        const init = {
          headers: auth,
          signal: signalWithDeadline(signal, MEDIA_HTTP_TIMEOUT_MS.metadata),
        }
        const [modelsResponse, samplersResponse] = await Promise.all([
          transport(`${base}/sdapi/v1/sd-models`, init),
          transport(`${base}/sdapi/v1/samplers`, init).catch(() => undefined),
        ])
        const models = modelsResponse.ok
          ? await readJson(modelsResponse)
          : undefined
        if (Array.isArray(models))
          checkpoints = models.filter(isRecord) as A1111Model[]
        const listed = samplersResponse?.ok
          ? await readJson(samplersResponse)
          : undefined
        if (Array.isArray(listed)) {
          samplers = listed
            .map((entry) =>
              isRecord(entry) ? (entry as A1111Sampler).name : undefined
            )
            .filter(
              (name): name is string =>
                typeof name === 'string' && name.length > 0
            )
        }
      } catch {
        // Unreachable: no models can be honestly listed. Health says why.
      }

      return {
        contract_version: MEDIA_CONTRACT_VERSION,
        provider_id: descriptor.id,
        devices: [],
        models: modelsFrom(descriptor.id, checkpoints, samplers),
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
          cancel: true,
          events: false,
          progress: true,
          queue: true,
          install: false,
          batch: true,
          // Not synchronous: the job can be queried while it runs.
          synchronous: false,
        },
      }
    },

    async submit(
      req: NormalizedMediaRequest,
      signal?: AbortSignal
    ): Promise<MediaJobSnapshot> {
      const taskId = taskIdFor(req)
      // Built before anything is sent, so invalid input never reaches the
      // server.
      const { route, body } = bodyFor(req, taskId)
      const auth = await headers(true)

      // The generation request belongs to the job, not to this call: it must
      // outlive `submit`, so it gets its own controller. The caller's signal
      // aborts it only while `submit` is still running.
      const controller = new AbortController()
      const abortWithCaller = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', abortWithCaller, { once: true })

      const job: Job = {
        taskId,
        controller,
        cancelled: false,
        done: Promise.resolve(),
      }
      job.done = transport(`${base}${route}`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw await errorFor(response, auth)
          return (await readJson(response)) as A1111ImagesResponse | undefined
        })
        .then(
          (payload) => {
            job.outcome = { kind: 'resolved', payload }
          },
          (reason: unknown) => {
            job.outcome = { kind: 'rejected', reason }
          }
        )
        .finally(() => stopWatching(job))
      jobs.set(req.client_job_id, job)

      try {
        const progress = await progressOf(
          taskId,
          signalWithDeadline(signal, MEDIA_HTTP_TIMEOUT_MS.metadata)
        )
        const snapshot = liveSnapshot(
          { client_job_id: req.client_job_id },
          job,
          progress
        )
        return { ...snapshot, started_at: Date.now() }
      } catch (error) {
        // The server could not confirm the job. Whatever stopped this request
        // stops the generation request too, so it is withdrawn rather than
        // left running unobserved.
        controller.abort()
        jobs.delete(req.client_job_id)
        throw error
      } finally {
        signal?.removeEventListener('abort', abortWithCaller)
      }
    },

    async poll(
      handle: MediaJobHandle,
      signal?: AbortSignal
    ): Promise<MediaJobSnapshot> {
      const job = jobFor(handle)
      if (job.settled) return job.settled
      if (job.cancelled) return settle(handle, job)

      // Let a response that has already arrived record itself first.
      await Promise.resolve()
      if (job.outcome) return settle(handle, job)

      const progress = await progressOf(
        job.taskId,
        signalWithDeadline(signal, MEDIA_HTTP_TIMEOUT_MS.metadata)
      )
      if (job.outcome) return settle(handle, job)

      if (progress.kind === 'task' && progress.completed) {
        // Finished on the server; the images are on their way.
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          job.done,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, completionGraceMs)
            signal?.addEventListener('abort', () => resolve(), { once: true })
          }),
        ])
        if (timer !== undefined) clearTimeout(timer)
        if (job.outcome) return settle(handle, job)
      }

      return liveSnapshot(handle, job, progress)
    },

    async cancel(handle: MediaJobHandle): Promise<void> {
      const job = jobFor(handle)
      if (job.settled || job.outcome) {
        // Already over; there is nothing on the server to stop.
        job.cancelled = true
        return
      }

      const progress = await progressOf(
        job.taskId,
        signalWithDeadline(undefined, MEDIA_HTTP_TIMEOUT_MS.metadata)
      )
      if (progress.kind === 'global') {
        // Refused rather than guessed: interrupt is server-wide, and without
        // the task-scoped endpoint nothing says the running job is this one.
        throw new A1111Error(
          'This AUTOMATIC1111 server runs without its web UI (--nowebui), so it cannot say which job is running. Interrupting could stop someone else’s.',
          'cancel_unsupported'
        )
      }
      if (progress.active) {
        await interrupt()
        job.cancelled = true
        job.controller.abort()
        return
      }
      job.cancelled = true
      // Completed: the images are arriving and will be discarded. Otherwise
      // queued: A1111 cannot dequeue a task, so interrupt it when it starts.
      if (!progress.completed) watchToInterrupt(job)
    },
  }
}

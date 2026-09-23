import { create } from 'zustand'

import { getServiceHub } from '@/hooks/useServiceHub'
import { i18n } from '@/i18n/react-i18next-compat'
import { toDiffusionError } from '@/lib/diffusion/errors'
import { shouldReportGenerateError } from '@/lib/diffusion/generation-stop'
import { parseArtifactId } from '@/lib/diffusion/models'
import { captureVideoGenerate } from '@/lib/diffusion/telemetry'
import { notifyThreadCompleted } from '@/lib/notifications'
import { capturePosterForClip, PosterBackfillQueue } from '@/lib/video/poster'
import { validateVideoRequest } from '@/lib/video/validate'
import type {
  DiffusionError,
  DiffusionEvent,
  GalleryVideoItem,
  VideoGenerateRequest,
  VideoJob,
  VideoJobState,
} from '@/services/diffusion/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useVideoGalleryStore } from '@/stores/video-gallery-store'

export type StartVideoGenerationOptions = {
  request: VideoGenerateRequest
  /** The seed typed by the user, or null to let the engine draw one. */
  seed: number | null
}

type VideoGenerationState = {
  bound: boolean
  currentJob: VideoJob | null
  /** True from `generateVideo` to the terminal job. One clip per Generate: no runs, no batches. */
  generating: boolean
  /** Stable clock origin for the viewer/gallery generation placeholder. */
  generationStartedAtMs: number | null
  stopRequested: boolean
  lastError: DiffusionError | null
  /** Clips whose poster could not be rendered in this session. */
  posterFailedIds: string[]

  bind: () => Promise<void>
  unbind: () => void
  handleEvent: (event: DiffusionEvent) => void

  startGeneration: (opts: StartVideoGenerationOptions) => Promise<void>
  stop: () => Promise<void>
  clearError: () => void
  /** Make the poster of a listed clip that has none, when its tile is seen. */
  requestPoster: (item: GalleryVideoItem) => void
  reset: () => void
}

const TERMINAL: ReadonlySet<VideoJobState> = new Set([
  'completed',
  'failed',
  'cancelled',
])

/** How often to ask the core directly while waiting for a terminal event. */
const FALLBACK_POLL_MS = 2000

const isTerminal = (job: VideoJob | null | undefined): boolean =>
  Boolean(job && TERMINAL.has(job.state))

/** Resolver for the job the page is waiting on, keyed by job id. Module state: a promise is not something to render. */
const waiters = new Map<string, (job: VideoJob) => void>()

let unsubscribe: (() => void) | null = null

const initial = {
  bound: false,
  currentJob: null as VideoJob | null,
  generating: false,
  generationStartedAtMs: null as number | null,
  stopRequested: false,
  lastError: null as DiffusionError | null,
  posterFailedIds: [] as string[],
}

export const useVideoGenerationStore = create<VideoGenerationState>()((
  set,
  get
) => {
  const diffusion = () => getServiceHub().diffusion()

  /**
   * Render the clip's first frame and hand it to the core, which stores it
   * as `<id>.thumb.png` and answers with the item carrying `posterPath`.
   */
  const makePoster = async (item: GalleryVideoItem) => {
    const png = await capturePosterForClip(item.path)
    const withPoster = await diffusion().setVideoPoster(item.id, png)
    useVideoGalleryStore.getState().patch(withPoster)
  }

  const posters = new PosterBackfillQueue({
    run: async (item) => {
      try {
        await makePoster(item)
      } catch (error) {
        set((state) => ({ posterFailedIds: [...state.posterFailedIds, item.id] }))
        throw error
      }
    },
  })

  /** Resolve when the job reaches a terminal state, by event or by polling. */
  const waitForTerminal = (jobId: string): Promise<VideoJob> =>
    new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setInterval> | null = null
      const finish = (job: VideoJob) => {
        if (settled) return
        settled = true
        waiters.delete(jobId)
        if (timer) clearInterval(timer)
        resolve(job)
      }
      waiters.set(jobId, finish)
      // The event stream is the fast path; the poll is insurance against a
      // dropped event (the page reloaded, the listener re-bound mid-job).
      timer = setInterval(() => {
        void diffusion()
          .getVideoJob(jobId)
          .then((job) => {
            if (job === null) {
              finish({
                ...(get().currentJob ?? placeholderJob(jobId)),
                id: jobId,
                state: 'failed',
                error: {
                  code: 'JOB_NOT_FOUND',
                  message: 'The job disappeared before it finished.',
                },
              })
              return
            }
            if (isTerminal(job)) finish(job)
            else if (get().currentJob?.id === jobId) set({ currentJob: job })
          })
          .catch(() => {
            // A transient IPC failure: the next tick tries again.
          })
      }, FALLBACK_POLL_MS)
    })

  const placeholderJob = (jobId: string): VideoJob => ({
    id: jobId,
    state: 'queued',
    modelId:
      useImageGenerationStore.getState().status?.model.loaded?.modelId ?? '',
    request: { prompt: '', width: 0, height: 0, steps: 0, cfgScale: 0 },
    createdAtMs: Date.now(),
    progress: null,
    outputs: [],
  })

  const reportJob = (job: VideoJob) => {
    const loaded = useImageGenerationStore.getState().status?.model.loaded
    const capabilities = useImageGenerationStore.getState().videoCapabilities
    const parsed = parseArtifactId(job.modelId || loaded?.modelId || '')
    const duration =
      job.finishedAtMs && job.startedAtMs
        ? job.finishedAtMs - job.startedAtMs
        : null
    captureVideoGenerate({
      generate_status:
        job.state === 'completed'
          ? 'completed'
          : job.state === 'cancelled'
            ? 'cancelled'
            : 'failed',
      model_family: parsed?.family ?? null,
      quant: parsed?.quantId ?? null,
      engine: loaded?.engine ?? null,
      backend: loaded?.backend ?? null,
      width: job.request.width,
      height: job.request.height,
      frames:
        job.request.frames ??
        job.outputs[0]?.frameCount ??
        capabilities?.frames.default ??
        0,
      fps: job.request.fps ?? job.outputs[0]?.fps ?? capabilities?.fps ?? 0,
      steps: job.request.steps,
      duration_ms: duration,
      error_code: job.error?.code ?? null,
    })
  }

  const notifyIfUnfocused = () => {
    if (typeof document !== 'undefined' && document.hasFocus()) return
    void notifyThreadCompleted(
      i18n.t('videos:notifications.readyTitle'),
      i18n.t('videos:notifications.readyBody')
    )
  }

  /** A job ended: land its clip, report it, and settle the page. */
  const settle = (job: VideoJob) => {
    if (job.state === 'completed') {
      useVideoGalleryStore.getState().prepend(job.outputs)
      for (const item of job.outputs) {
        void posters.request(item)
      }
    } else if (
      job.error &&
      shouldReportGenerateError({
        code: job.error.code,
        stopRequested: get().stopRequested,
      })
    ) {
      set({ lastError: job.error })
    }
    reportJob(job)
    set({ currentJob: null, generating: false, generationStartedAtMs: null })
  }

  /** Take over a job that is already running in the core. */
  const adopt = (active: VideoJob) => {
    if (isTerminal(active) || get().generating) return
    useVideoGalleryStore.getState().selectLive()
    set({
      currentJob: active,
      generating: true,
      generationStartedAtMs: active.startedAtMs ?? active.createdAtMs,
      stopRequested: false,
    })
    void waitForTerminal(active.id).then(settle)
  }

  return {
    ...initial,

    bind: async () => {
      if (get().bound) return
      set({ bound: true })
      const service = diffusion()
      if (!service.isSupported()) return

      unsubscribe?.()
      unsubscribe = service.subscribe((event) => get().handleEvent(event))

      // A clip that was being made before this page (or this window)
      // existed: show its progress instead of a blank form that lets the
      // user submit a second job on top.
      try {
        const status = await service.getStatus()
        if (status.activeVideoJob) adopt(status.activeVideoJob)
      } catch (error) {
        console.error('[videos] status unavailable:', error)
      }
    },

    unbind: () => {
      unsubscribe?.()
      unsubscribe = null
      set({ bound: false })
    },

    handleEvent: (event) => {
      switch (event.type) {
        case 'video-progress': {
          const current = get().currentJob
          if (current && current.id === event.jobId) {
            set({
              currentJob: {
                ...current,
                state:
                  current.state === 'queued' ? 'generating' : current.state,
                progress: event.progress,
              },
            })
          }
          return
        }
        case 'video-job': {
          const current = get().currentJob
          if (!current || current.id === event.job.id) {
            if (!isTerminal(event.job)) set({ currentJob: event.job })
          }
          const waiter = waiters.get(event.job.id)
          if (waiter && isTerminal(event.job)) waiter(event.job)
          // A clip nobody here is waiting for — an outside client on
          // `/v1/videos`, or another window — still lands in the core's
          // gallery; show it, and give it a poster.
          if (!waiter && event.job.state === 'completed') {
            useVideoGalleryStore.getState().prepend(event.job.outputs)
            for (const item of event.job.outputs) posters.request(item)
            if (current?.id === event.job.id) set({ currentJob: null })
          } else if (!waiter && isTerminal(event.job) && current?.id === event.job.id) {
            set({ currentJob: null })
          }
          return
        }
        case 'error': {
          const current = get().currentJob
          if (
            current &&
            current.id === event.jobId &&
            shouldReportGenerateError({
              code: event.code,
              stopRequested: get().stopRequested,
            })
          ) {
            set({
              lastError: {
                code: event.code,
                message: event.message,
                details: event.details,
              },
            })
          }
          return
        }
        case 'reset': {
          // A new core generation knows nothing of a job that was running;
          // the image store re-configures it. Drop what this page was waiting
          // for: the poll notices the job is gone and fails it.
          return
        }
        default:
          return
      }
    },

    startGeneration: async ({ request, seed }) => {
      if (get().generating) return
      const capabilities = useImageGenerationStore.getState().videoCapabilities
      if (capabilities) {
        const verdict = validateVideoRequest(request, capabilities)
        if (!verdict.ok) {
          set({ lastError: { code: verdict.code, message: verdict.message } })
          return
        }
      }
      useVideoGalleryStore.getState().selectLive()
      set({
        generating: true,
        generationStartedAtMs: Date.now(),
        stopRequested: false,
        lastError: null,
      })
      let jobId: string
      try {
        const submitted = await diffusion().generateVideo({
          ...request,
          ...(seed === null ? {} : { seed }),
        })
        jobId = submitted.jobId
      } catch (error) {
        set({
          lastError: toDiffusionError(error),
          generating: false,
          generationStartedAtMs: null,
        })
        return
      }
      set({ currentJob: placeholderJob(jobId) })
      const job = await waitForTerminal(jobId)
      settle(job)
      if (job.state === 'completed') notifyIfUnfocused()
    },

    stop: async () => {
      const job = get().currentJob
      set({ stopRequested: true })
      if (!job) return
      try {
        await diffusion().cancelVideoJob(job.id)
      } catch (error) {
        console.error('[videos] cancel failed:', error)
      }
    },

    clearError: () => set({ lastError: null }),

    requestPoster: (item) => posters.request(item),

    reset: () => {
      waiters.clear()
      posters.clear()
      set({ ...initial })
    },
  }
})

/** Test seam: drop the waiters and the poster queue of a previous test. */
export function resetVideoGenerationForTests(): void {
  useVideoGenerationStore.getState().reset()
}

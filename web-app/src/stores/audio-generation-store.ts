import { create } from 'zustand'

import { route } from '@/constants/routes'
import { getServiceHub } from '@/hooks/useServiceHub'
import { i18n } from '@/i18n/react-i18next-compat'
import { isMissingAudioRoute, toAudioError } from '@/lib/audio/errors'
import {
  AUDIO_DEFAULTS,
  adoptAudioModel,
  audioCatalogIdOf,
  audioTargetOf,
  audioWireId,
  buildAudioLoadRequest,
  buildAudioRequest,
  deleteAudioQuant,
  formsForCatalog,
  resetAudioSettings,
  type AudioMode,
  type AudioSettings,
} from '@/lib/audio/models'
import { isPageOnScreen } from '@/lib/navigation'
import { notifyUnlessWatching } from '@/lib/notifications'
import {
  fetchAudioCatalog,
  findAudioModel,
  getBaselineAudioCatalog,
  recommendedAudioQuant,
  type AudioCatalog,
} from '@/services/audio-catalog-registry'
import {
  audioEngineInstallError,
  installAudioEngine,
} from '@/services/audio/engine'
import type {
  AudioCapabilities,
  AudioErrorBody,
  AudioEvent,
  AudioGalleryItem,
  AudioJob,
  AudioJobState,
  AudioModelFile,
  AudioStatus,
} from '@/services/audio/types'
import { engineBuildProxy } from '@/services/engine-builds/core'

/**
 * Whether this core does audio at all. `too-old`: it has no `/audio/*` routes
 * (0.20.5), which is a fact about the installed app to state quietly, never an
 * error. `unreachable`: it did not answer; the relay's next snapshot tries again.
 */
export type AudioCoreState = 'checking' | 'ready' | 'too-old' | 'unreachable'

export type AudioEngineInstallProgress = {
  inFlight: boolean
  transferred: number
  total: number
  error: AudioErrorBody | null
}

type AudioGenerationState = {
  bound: boolean
  core: AudioCoreState
  status: AudioStatus | null
  /** What the loaded model takes; null while nothing is loaded. */
  capabilities: AudioCapabilities | null
  /** The bundled snapshot until the registry answers. */
  catalog: AudioCatalog
  modelFiles: AudioModelFile[]

  /** The build this host would install, or null when none fits. */
  hostBackendId: string | null
  hostBackendReason: string | null
  /** Bytes an install downloads, when the core knows. */
  engineDownloadBytes: number | null
  /** The host check answered, a "no build" answer included. */
  hostBackendResolved: boolean
  engineInstall: AudioEngineInstallProgress

  mode: AudioMode
  /** Each mode keeps its settings while the app runs. */
  forms: Record<AudioMode, AudioSettings>

  /** A `loadModel` is in flight for this wire id. */
  loadingModelId: string | null
  currentJob: AudioJob | null
  /** True from the submit to the job's terminal state. */
  generating: boolean
  stopRequested: boolean
  lastError: AudioErrorBody | null

  gallery: AudioGalleryItem[]
  galleryTotal: number
  galleryHasMore: boolean
  /** The clip in the player. */
  selectedId: string | null

  bind: () => Promise<void>
  handleEvent: (event: AudioEvent) => void
  refreshStatus: () => Promise<void>
  refreshCatalog: () => Promise<void>
  refreshModelFiles: () => Promise<void>
  refreshHostBackend: (opts?: { force?: boolean }) => Promise<void>
  refreshGallery: () => Promise<void>
  loadMoreGallery: () => Promise<void>

  setMode: (mode: AudioMode) => void
  changeForm: (patch: Partial<AudioSettings>) => void
  /** Make the catalog model the mode's, with its numbers. */
  pickModel: (modelId: string) => void
  resetForm: () => void

  installEngine: (opts?: { force?: boolean }) => Promise<void>
  /** Resolves true once the model serves requests; a failure lands in `lastError`. */
  loadModel: (wireId: string) => Promise<boolean>
  unloadModel: () => Promise<void>
  /** Delete a catalog model's file; the loaded model is stopped first. */
  removeModel: (modelId: string) => Promise<void>

  /** Load the form's model when it is not the loaded one, then generate. */
  generate: () => Promise<void>
  stop: () => Promise<void>
  clearError: () => void

  selectClip: (id: string | null) => void
  /** Rejects with the core's error; the dialog that asked reports it. */
  deleteClip: (id: string) => Promise<void>

  reset: () => void
}

const TERMINAL: ReadonlySet<AudioJobState> = new Set([
  'completed',
  'failed',
  'cancelled',
])

/** How often to ask the core directly while waiting for a terminal event. */
const FALLBACK_POLL_MS = 2000

/** Clips listed per page. */
export const AUDIO_GALLERY_PAGE = 50

const isTerminal = (job: AudioJob | null | undefined): boolean =>
  Boolean(job && TERMINAL.has(job.state))

/**
 * Resolvers for the job the store is waiting on, keyed by job id. Module state
 * rather than store state: a promise is not something to render.
 */
const waiters = new Map<string, (job: AudioJob) => void>()

let unsubscribe: (() => void) | null = null

const emptyInstall: AudioEngineInstallProgress = {
  inFlight: false,
  transferred: 0,
  total: 0,
  error: null,
}

const initial = () => ({
  bound: false,
  core: 'checking' as AudioCoreState,
  status: null as AudioStatus | null,
  capabilities: null as AudioCapabilities | null,
  catalog: getBaselineAudioCatalog(),
  modelFiles: [] as AudioModelFile[],
  hostBackendId: null as string | null,
  hostBackendReason: null as string | null,
  engineDownloadBytes: null as number | null,
  hostBackendResolved: false,
  engineInstall: emptyInstall,
  mode: 'speech' as AudioMode,
  forms: formsForCatalog(AUDIO_DEFAULTS, getBaselineAudioCatalog()),
  loadingModelId: null as string | null,
  currentJob: null as AudioJob | null,
  generating: false,
  stopRequested: false,
  lastError: null as AudioErrorBody | null,
  gallery: [] as AudioGalleryItem[],
  galleryTotal: 0,
  galleryHasMore: false,
  selectedId: null as string | null,
})

const proxyRequest = (): { proxy?: ReturnType<typeof engineBuildProxy> } => {
  const proxy = engineBuildProxy()
  return proxy ? { proxy } : {}
}

export const useAudioGenerationStore = create<AudioGenerationState>()((
  set,
  get
) => {
  const audio = () => getServiceHub().audio()

  /** Resolve when the job reaches a terminal state, by event or by polling. */
  const waitForTerminal = (jobId: string): Promise<AudioJob> =>
    new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setInterval> | null = null
      const finish = (job: AudioJob) => {
        if (settled) return
        settled = true
        waiters.delete(jobId)
        if (timer) clearInterval(timer)
        resolve(job)
      }
      waiters.set(jobId, finish)
      // The event stream is the fast path; the poll is insurance against a
      // dropped event and against a core that restarted under the job.
      timer = setInterval(() => {
        void audio()
          .getJob(jobId)
          .then((job) => {
            if (job === null) {
              const running = get().currentJob
              if (running) {
                finish({
                  ...running,
                  id: jobId,
                  state: 'failed',
                  error: {
                    code: 'ENGINE_CRASHED',
                    message: 'The core no longer knows this job.',
                  },
                })
              }
              return
            }
            if (isTerminal(job)) finish(job)
            else if (get().currentJob?.id === jobId) set({ currentJob: job })
          })
          .catch(() => {
            // A transient failure, or a core too busy to answer: the next tick tries again.
          })
      }, FALLBACK_POLL_MS)
    })

  /** Put a finished clip at the top of the list; the core lists newest first. */
  const prepend = (item: AudioGalleryItem) => {
    const { gallery, galleryTotal } = get()
    if (gallery.some((clip) => clip.id === item.id)) return
    set({ gallery: [item, ...gallery], galleryTotal: galleryTotal + 1 })
  }

  const notifyReady = () => {
    notifyUnlessWatching(
      isPageOnScreen(route.audios.index),
      i18n.t('audios:notifications.readyTitle'),
      i18n.t('audios:notifications.readyBody')
    )
  }

  /** Take a job's outcome into the gallery or the banner. */
  const settle = (job: AudioJob) => {
    if (job.state === 'completed' && job.output) {
      prepend(job.output)
      set({ selectedId: job.output.id })
      notifyReady()
      return
    }
    if (job.state === 'cancelled' || job.error?.code === 'CANCELLED') return
    if (job.state === 'failed') {
      set({
        lastError: job.error ?? {
          code: 'INTERNAL',
          message: 'The job failed without a reason.',
        },
      })
    }
  }

  /** Wait out a job the store did not start: one running before this window opened. */
  const adopt = (job: AudioJob) => {
    set({ currentJob: job, generating: true, stopRequested: false })
    void waitForTerminal(job.id).then((finished) => {
      settle(finished)
      set({ currentJob: null, generating: false, stopRequested: false })
    })
  }

  const refreshCapabilities = async () => {
    if (!get().status?.model.loaded) {
      set({ capabilities: null })
      return
    }
    try {
      set({ capabilities: await audio().getCapabilities() })
    } catch (error) {
      console.warn('[audios] capabilities unavailable:', error)
    }
  }

  /** Ask the core everything the page shows, or find out that it cannot say. */
  const connect = async () => {
    let status: AudioStatus
    try {
      status = await audio().getStatus()
    } catch (error) {
      set({
        core: isMissingAudioRoute(error) ? 'too-old' : 'unreachable',
        status: null,
        capabilities: null,
        modelFiles: [],
      })
      return
    }
    set({ core: 'ready', status })
    await Promise.all([
      get().refreshModelFiles(),
      get().refreshGallery(),
      get().refreshHostBackend(),
    ])
    const active = get().status?.activeJob
    if (active && !isTerminal(active) && !get().generating) adopt(active)
    await refreshCapabilities()
  }

  return {
    ...initial(),

    bind: async () => {
      if (get().bound) return
      set({ bound: true })
      const service = audio()
      // Offered whatever the core can do: the list says what would run here.
      void get().refreshCatalog()
      if (!service.isSupported()) {
        set({ core: 'unreachable' })
        return
      }
      unsubscribe?.()
      unsubscribe = service.subscribe((event) => get().handleEvent(event))
      await connect()
    },

    handleEvent: (event) => {
      switch (event.type) {
        case 'state': {
          const previous = get().status
          set({ core: 'ready', status: event.status })
          const { model } = event.status
          if (model.state !== 'loaded') {
            set({ capabilities: null })
          } else if (
            previous?.model.loaded?.modelId !== model.loaded?.modelId
          ) {
            void refreshCapabilities()
          }
          // Once per failure: a dismissed banner stays dismissed.
          if (
            model.error &&
            model.error.message !== previous?.model.error?.message &&
            !get().generating
          ) {
            set({ lastError: model.error })
          }
          return
        }
        case 'job': {
          const { job } = event
          const waiter = waiters.get(job.id)
          if (get().currentJob?.id === job.id && !isTerminal(job)) {
            set({ currentJob: job })
          }
          if (isTerminal(job) && waiter) {
            waiter(job)
          } else if (job.state === 'completed' && job.output) {
            // A clip nobody here is waiting for: `/v1/audio/speech`, another
            // window, or an event that beat the submit's answer.
            prepend(job.output)
          }
          return
        }
        case 'error': {
          if (!event.jobId || event.jobId === get().currentJob?.id) {
            if (event.code === 'CANCELLED' && get().stopRequested) return
            set({
              lastError: {
                code: event.code,
                message: event.message,
                ...(event.details ? { details: event.details } : {}),
              },
            })
          }
          return
        }
        case 'reset':
          void connect()
          return
      }
    },

    refreshStatus: async () => {
      try {
        set({ status: await audio().getStatus() })
      } catch (error) {
        console.warn('[audios] status unavailable:', error)
      }
    },

    refreshCatalog: async () => {
      const { catalog } = await fetchAudioCatalog()
      set((state) => ({
        catalog,
        forms: formsForCatalog(state.forms, catalog),
      }))
    },

    refreshModelFiles: async () => {
      if (get().core !== 'ready') return
      try {
        set({ modelFiles: await audio().listModelFiles() })
      } catch (error) {
        console.warn('[audios] model files unavailable:', error)
      }
    },

    refreshHostBackend: async ({ force } = {}) => {
      if (get().core !== 'ready') return
      try {
        const catalog = await audio().engineCatalog({
          ...proxyRequest(),
          ...(force ? { force: true } : {}),
        })
        set({
          hostBackendId: catalog.host_backend_id,
          hostBackendReason: catalog.host_backend_id
            ? null
            : (catalog.manifest_error ?? catalog.host_reason),
          engineDownloadBytes: catalog.host_download_bytes ?? null,
          hostBackendResolved: true,
        })
      } catch (error) {
        console.warn('[audios] engine catalog unavailable:', error)
        set({
          hostBackendId: null,
          hostBackendReason: toAudioError(error).message,
          engineDownloadBytes: null,
          hostBackendResolved: true,
        })
      }
    },

    refreshGallery: async () => {
      if (get().core !== 'ready') return
      try {
        const page = await audio().listGallery({
          offset: 0,
          limit: AUDIO_GALLERY_PAGE,
        })
        const { selectedId } = get()
        const kept = page.items.some((clip) => clip.id === selectedId)
        set({
          gallery: page.items,
          galleryTotal: page.total,
          galleryHasMore: page.hasMore,
          selectedId: kept ? selectedId : (page.items[0]?.id ?? null),
        })
      } catch (error) {
        console.warn('[audios] gallery unavailable:', error)
      }
    },

    loadMoreGallery: async () => {
      const { gallery, galleryHasMore } = get()
      if (!galleryHasMore) return
      try {
        const page = await audio().listGallery({
          offset: gallery.length,
          limit: AUDIO_GALLERY_PAGE,
        })
        const known = new Set(get().gallery.map((clip) => clip.id))
        set({
          gallery: [
            ...get().gallery,
            ...page.items.filter((clip) => !known.has(clip.id)),
          ],
          galleryTotal: page.total,
          galleryHasMore: page.hasMore,
        })
      } catch (error) {
        console.warn('[audios] gallery page unavailable:', error)
      }
    },

    setMode: (mode) => set({ mode }),

    changeForm: (patch) =>
      set((state) => ({
        forms: {
          ...state.forms,
          [state.mode]: { ...state.forms[state.mode], ...patch },
        },
      })),

    pickModel: (modelId) => {
      const model = findAudioModel(get().catalog, modelId)
      if (!model) return
      set((state) => ({
        forms: {
          ...state.forms,
          [model.mode]: adoptAudioModel(state.forms[model.mode], model),
        },
      }))
    },

    resetForm: () =>
      set((state) => {
        const form = state.forms[state.mode]
        return {
          forms: {
            ...state.forms,
            [state.mode]: resetAudioSettings(
              form,
              findAudioModel(state.catalog, form.modelId)
            ),
          },
        }
      }),

    installEngine: async ({ force } = {}) => {
      if (get().engineInstall.inFlight) return
      set({ engineInstall: { ...emptyInstall, inFlight: true } })
      try {
        await installAudioEngine({
          force,
          onProgress: ({ transferred, total }) =>
            set((state) => ({
              engineInstall: { ...state.engineInstall, transferred, total },
            })),
        })
        await get().refreshStatus()
        set({ engineInstall: emptyInstall })
      } catch (error) {
        const described = toAudioError(audioEngineInstallError(error))
        // A cancel from the download panel is the user's choice.
        set({
          engineInstall:
            described.code === 'CANCELLED'
              ? emptyInstall
              : { ...emptyInstall, error: described },
        })
      }
    },

    loadModel: async (wireId) => {
      const model = findAudioModel(get().catalog, audioCatalogIdOf(wireId))
      const quant = model?.quants.find(
        (entry) => audioWireId(model, entry) === wireId
      )
      if (!model || !quant) {
        set({
          lastError: {
            code: 'MODEL_MISSING',
            message: `Unknown model ${wireId}.`,
          },
        })
        return false
      }
      set({ loadingModelId: wireId, lastError: null })
      try {
        await audio().loadModel(buildAudioLoadRequest(model, quant))
        const capabilities = await audio().getCapabilities()
        set({ capabilities })
        await get().refreshStatus()
        return true
      } catch (error) {
        set({ lastError: toAudioError(error) })
        return false
      } finally {
        set({ loadingModelId: null })
      }
    },

    unloadModel: async () => {
      try {
        await audio().unloadModel()
        set({ capabilities: null })
        await get().refreshStatus()
      } catch (error) {
        set({ lastError: toAudioError(error) })
      }
    },

    removeModel: async (modelId) => {
      const { catalog, status } = get()
      const model = findAudioModel(catalog, modelId)
      if (!model) return
      const quant = recommendedAudioQuant(model)
      if (status?.model.loaded?.modelId === audioWireId(model, quant)) {
        await get().unloadModel()
      }
      try {
        await deleteAudioQuant(quant)
      } catch (error) {
        set({ lastError: toAudioError(error) })
      }
      await get().refreshModelFiles()
    },

    generate: async () => {
      const { generating, loadingModelId, catalog, forms, mode } = get()
      if (generating || loadingModelId) return
      const target = audioTargetOf(catalog, forms[mode])
      if (!target) return
      set({ lastError: null })
      const wireId = audioWireId(target.model, target.quant)
      if (
        get().status?.model.loaded?.modelId !== wireId &&
        !(await get().loadModel(wireId))
      ) {
        return
      }
      set({ generating: true, stopRequested: false })
      try {
        const job = await audio().generate(
          mode,
          buildAudioRequest(target.model, get().forms[mode])
        )
        set({ currentJob: job })
        settle(isTerminal(job) ? job : await waitForTerminal(job.id))
      } catch (error) {
        set({ lastError: toAudioError(error) })
      } finally {
        set({ currentJob: null, generating: false, stopRequested: false })
      }
    },

    stop: async () => {
      const job = get().currentJob
      if (!job) return
      set({ stopRequested: true })
      try {
        await audio().cancelJob(job.id)
      } catch (error) {
        console.warn('[audios] cancel failed:', error)
      }
    },

    clearError: () => set({ lastError: null }),

    selectClip: (id) => set({ selectedId: id }),

    deleteClip: async (id) => {
      await audio().deleteGalleryItem(id)
      set((state) => {
        const index = state.gallery.findIndex((clip) => clip.id === id)
        const gallery = state.gallery.filter((clip) => clip.id !== id)
        return {
          gallery,
          galleryTotal: Math.max(0, state.galleryTotal - 1),
          selectedId:
            state.selectedId === id
              ? (gallery[Math.min(index, gallery.length - 1)]?.id ?? null)
              : state.selectedId,
        }
      })
    },

    reset: () => {
      unsubscribe?.()
      unsubscribe = null
      waiters.clear()
      set(initial())
    },
  }
})

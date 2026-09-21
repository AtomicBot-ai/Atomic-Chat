import { create } from 'zustand'

import { useHardware } from '@/hooks/useHardware'
import { useImageForm } from '@/hooks/useImageForm'
import { useImageSetting } from '@/hooks/useImageSetting'
import { getServiceHub } from '@/hooks/useServiceHub'
import { i18n } from '@/i18n/react-i18next-compat'
import { acquireGpuForDiffusion } from '@/lib/diffusion/arbiter'
import { configureDiffusion, getDiffusionPaths } from '@/lib/diffusion/config'
import { toDiffusionError } from '@/lib/diffusion/errors'
import { fitForQuant } from '@/lib/diffusion/fit'
import {
  shouldContinueGenerating,
  shouldReportGenerateError,
} from '@/lib/diffusion/generation-stop'
import {
  buildLoadRequest,
  deleteArtifact as deleteArtifactFiles,
  listInstalledArtifacts,
  parseArtifactId,
  workflowNeedsLlmVision,
  type InstalledArtifact,
} from '@/lib/diffusion/models'
import {
  captureImageEngineInstall,
  captureImageGenerate,
} from '@/lib/diffusion/telemetry'
import { validateImageRequest } from '@/lib/diffusion/validate'
import { describeHardware, type HardwareProfile } from '@/lib/hardware-tier'
import { notifyThreadCompleted } from '@/lib/notifications'
import {
  supportsDiffusionFamily,
  MODERN_IMAGE_ENGINE_TAG,
} from '@/services/diffusion/compatibility'
import {
  ensureDiffusionBackend,
  resolveSdcppManifest,
  selectDiffusionBackendForHost,
} from '@/services/diffusion/install'
import type {
  DiffusionError,
  DiffusionEvent,
  DiffusionModelFile,
  DiffusionStatus,
  ImageCapabilities,
  ImageGenerateRequest,
  ImageJob,
  ImageJobState,
} from '@/services/diffusion/types'
import {
  fetchDiffusionCatalog,
  findFamily,
  findQuant,
  type DiffusionCatalog,
} from '@/services/diffusion-catalog-registry'
import { useImageGalleryStore } from '@/stores/image-gallery-store'

/** 0 = what it is, 1 = install the engine, 2 = pick and download a model. */
export type ImageSetupStep = 0 | 1 | 2

export type EngineInstallProgress = {
  inFlight: boolean
  transferred: number
  total: number
  error: DiffusionError | null
}

/** What the last look at the engine manifest found. */
export type EngineUpdateState = {
  checking: boolean
  /** A newer tag published for this host, or null when the install is current. */
  availableTag: string | null
  checkedAt: number | null
  error: string | null
}

export type DiffusionPaths = {
  dataFolder: string
  modelsRoot: string
  backendsRoot: string
  imagesDir: string
}

export type StartGenerationOptions = {
  request: ImageGenerateRequest
  /** How many times to submit the request. Each run is one job of `batchSize` images. */
  runs: number
  /** The seed typed by the user, or null to let the engine draw one per run. */
  baseSeed: number | null
}

type ImageGenerationState = {
  bound: boolean
  status: DiffusionStatus | null
  capabilities: ImageCapabilities | null
  catalog: DiffusionCatalog | null
  catalogSource: 'remote' | 'cache' | 'baseline' | null
  modelFiles: DiffusionModelFile[]
  installedArtifacts: InstalledArtifact[]
  paths: DiffusionPaths | null
  /** The backend id the host qualifies for, or null when this machine cannot run the engine. */
  hostBackendId: string | null
  hostBackendReason: string | null
  /** True once host compatibility has been checked; null is otherwise ambiguous. */
  hostBackendResolved: boolean

  currentJob: ImageJob | null
  runsTotal: number
  runsDone: number
  stopRequested: boolean
  /** True while the loop is running, from the first `generate` to the last terminal job. */
  generating: boolean
  /** Stable clock origin for the canvas/gallery generation placeholders. */
  generationStartedAtMs: number | null
  lastError: DiffusionError | null

  /** A `loadModel` is in flight for this artifact id. */
  loadingArtifactId: string | null
  /** An `unloadModel` is in flight for this resident artifact id. */
  unloadingArtifactId: string | null
  engineInstall: EngineInstallProgress
  engineUpdate: EngineUpdateState
  pendingEngineArtifactId: string | null

  setupOpen: boolean
  setupStep: ImageSetupStep

  bind: () => Promise<void>
  unbind: () => void
  handleEvent: (event: DiffusionEvent) => void
  refreshStatus: () => Promise<void>
  refreshCatalog: () => Promise<void>
  refreshModelFiles: () => Promise<void>
  /**
   * Configure the core again with every setting it keeps in memory: the idle
   * interval and the chosen output folder. After a residency setting changes,
   * and on a new core attachment.
   */
  applyIdleSettings: () => Promise<void>

  installEngine: (opts?: { force?: boolean; family?: string }) => Promise<void>
  /**
   * Compare the installed engine with the manifest's tag for this host.
   * `force` bypasses the hour-long manifest cache (the user pressed the button).
   */
  checkEngineUpdate: (opts?: { force?: boolean }) => Promise<void>
  /** Install the tag the last check found, unloading the model first: the old binary is retired. */
  updateEngine: () => Promise<void>
  loadModel: (artifactId: string) => Promise<void>
  unloadModel: () => Promise<void>
  removeArtifact: (artifactId: string) => Promise<void>

  startGeneration: (opts: StartGenerationOptions) => Promise<void>
  stop: () => Promise<void>
  clearError: () => void

  openSetup: (step?: ImageSetupStep) => void
  closeSetup: () => void
  reset: () => void
}

const TERMINAL: ReadonlySet<ImageJobState> = new Set([
  'completed',
  'failed',
  'cancelled',
])

/** How often to ask the plugin directly while waiting for a terminal event. */
const FALLBACK_POLL_MS = 2000

const isTerminal = (job: ImageJob | null | undefined): boolean =>
  Boolean(job && TERMINAL.has(job.state))

/**
 * Resolvers for jobs the loop is waiting on, keyed by job id. Module state
 * rather than store state: a promise is not something to render.
 */
const waiters = new Map<string, (job: ImageJob) => void>()

let unsubscribe: (() => void) | null = null

function hardwareProfile(): HardwareProfile | null {
  const hw = useHardware.getState().hardwareData
  return describeHardware({
    os_type: hw.os_type || (IS_MACOS ? 'macos' : ''),
    cpu: hw.cpu,
    total_memory: hw.total_memory,
    gpus: hw.gpus,
  })
}

const emptyInstall: EngineInstallProgress = {
  inFlight: false,
  transferred: 0,
  total: 0,
  error: null,
}

const noUpdate: EngineUpdateState = {
  checking: false,
  availableTag: null,
  checkedAt: null,
  error: null,
}

const initial = {
  bound: false,
  status: null as DiffusionStatus | null,
  capabilities: null as ImageCapabilities | null,
  catalog: null as DiffusionCatalog | null,
  catalogSource: null as ImageGenerationState['catalogSource'],
  modelFiles: [] as DiffusionModelFile[],
  installedArtifacts: [] as InstalledArtifact[],
  paths: null as DiffusionPaths | null,
  hostBackendId: null as string | null,
  hostBackendReason: null as string | null,
  hostBackendResolved: false,
  currentJob: null as ImageJob | null,
  runsTotal: 0,
  runsDone: 0,
  stopRequested: false,
  generating: false,
  generationStartedAtMs: null as number | null,
  lastError: null as DiffusionError | null,
  loadingArtifactId: null as string | null,
  unloadingArtifactId: null as string | null,
  engineInstall: emptyInstall,
  engineUpdate: noUpdate,
  pendingEngineArtifactId: null,
  setupOpen: false,
  setupStep: 0 as ImageSetupStep,
}

export const useImageGenerationStore = create<ImageGenerationState>()((
  set,
  get
) => {
  const diffusion = () => getServiceHub().diffusion()
  let updatingEngine = false

  /** Resolve when the job reaches a terminal state, by event or by polling. */
  const waitForTerminal = (jobId: string): Promise<ImageJob> =>
    new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setInterval> | null = null
      const finish = (job: ImageJob) => {
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
          .getJob(jobId)
          .then((job) => {
            if (job === null) {
              // The plugin forgot the job — nothing more will arrive for it.
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

  const placeholderJob = (jobId: string): ImageJob => ({
    id: jobId,
    state: 'queued',
    modelId: get().status?.model.loaded?.modelId ?? '',
    request: {
      prompt: '',
      width: 0,
      height: 0,
      steps: 0,
      cfgScale: 0,
      batchSize: 1,
    },
    createdAtMs: Date.now(),
    progress: null,
    outputs: [],
  })

  const recomputeInstalled = () => {
    const { catalog, modelFiles } = get()
    set({
      installedArtifacts: catalog
        ? listInstalledArtifacts(catalog, modelFiles)
        : [],
    })
  }

  const reportJob = (job: ImageJob, runs: number) => {
    const loaded = get().status?.model.loaded
    // An id the parser does not know reports the run without the model.
    const parsed = parseArtifactId(job.modelId || loaded?.modelId || '')
    const family = parsed?.family ?? null
    const quant = parsed?.quantId ?? null
    const duration =
      job.finishedAtMs && job.startedAtMs
        ? job.finishedAtMs - job.startedAtMs
        : null
    captureImageGenerate({
      generate_status:
        job.state === 'completed'
          ? 'completed'
          : job.state === 'cancelled'
            ? 'cancelled'
            : 'failed',
      model_family: family,
      quant,
      engine: loaded?.engine ?? null,
      backend: loaded?.backend ?? null,
      width: job.request.width,
      height: job.request.height,
      steps: job.request.steps,
      batch_size: job.request.batchSize,
      runs,
      duration_ms: duration,
      error_code: job.error?.code ?? null,
    })
  }

  const notifyIfUnfocused = (count: number) => {
    if (count <= 0) return
    if (typeof document !== 'undefined' && document.hasFocus()) return
    void notifyThreadCompleted(
      i18n.t('images:notifications.readyTitle'),
      i18n.t('images:notifications.readyBody', { count })
    )
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

      try {
        const status = await configureCore()
        set({ status })
      } catch (error) {
        console.error('[images] configure failed:', error)
        set({ lastError: toDiffusionError(error) })
      }

      await Promise.all([
        get().refreshStatus(),
        get().refreshCatalog(),
        get().refreshModelFiles(),
        getDiffusionPaths()
          .then((paths) => set({ paths }))
          .catch((error) =>
            console.error('[images] paths unavailable:', error)
          ),
        selectDiffusionBackendForHost()
          .then(({ backendId, reason }) =>
            set({
              hostBackendId: backendId,
              hostBackendReason: reason ?? null,
              hostBackendResolved: true,
            })
          )
          .catch((error) => {
            console.error('[images] backend selection failed:', error)
            set({
              hostBackendId: null,
              hostBackendReason:
                error instanceof Error ? error.message : String(error),
              hostBackendResolved: true,
            })
          }),
      ])

      // Adopt a job that was running before this page (or this window)
      // existed, so a reload mid-generation shows progress instead of a
      // blank form that lets the user submit a second job on top.
      const active = get().status?.activeJob
      if (active && !isTerminal(active) && !get().generating) {
        useImageGalleryStore.getState().selectLive()
        set({
          currentJob: active,
          generating: true,
          generationStartedAtMs: active.startedAtMs ?? active.createdAtMs,
          runsTotal: 1,
          runsDone: 0,
          stopRequested: false,
        })
        void waitForTerminal(active.id).then((job) => {
          if (job.state === 'completed') {
            useImageGalleryStore.getState().prepend(job.outputs)
            set({ runsDone: 1 })
          } else if (
            job.error &&
            shouldReportGenerateError({
              code: job.error.code,
              stopRequested: get().stopRequested,
            })
          ) {
            set({ lastError: job.error })
          }
          reportJob(job, 1)
          set({
            currentJob: null,
            generating: false,
            generationStartedAtMs: null,
          })
        })
      }

      // The capabilities only exist while a model is resident.
      if (get().status?.model.state === 'loaded') {
        try {
          set({ capabilities: await service.getCapabilities() })
        } catch (error) {
          console.error('[images] capabilities unavailable:', error)
        }
      }
    },

    unbind: () => {
      unsubscribe?.()
      unsubscribe = null
      set({ bound: false })
    },

    handleEvent: (event) => {
      switch (event.type) {
        case 'state': {
          const previous = get().status
          set({ status: event.status })
          if (event.status.model.state !== 'loaded') {
            set({ capabilities: null })
          } else if (
            previous?.model.state !== 'loaded' &&
            get().capabilities === null
          ) {
            void diffusion()
              .getCapabilities()
              .then((capabilities) => set({ capabilities }))
              .catch(() => {})
          }
          if (event.status.model.error && !get().generating) {
            set({ lastError: event.status.model.error })
          }
          return
        }
        case 'progress': {
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
        case 'job': {
          const current = get().currentJob
          if (!current || current.id === event.job.id) {
            if (!isTerminal(event.job)) set({ currentJob: event.job })
          }
          const waiter = waiters.get(event.job.id)
          if (waiter && isTerminal(event.job)) waiter(event.job)
          return
        }
        case 'error': {
          const current = get().currentJob
          if (!event.jobId || current?.id === event.jobId) {
            if (
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
          }
          return
        }
        case 'reset': {
          // A new core generation knows nothing: neither the output folder
          // nor the idle interval, nor a job that was running. The relay
          // also sends this on a reattach or a resync to the same core,
          // which still holds its configuration; the configure below sends
          // every setting the app keeps, so it restores a new core and
          // changes nothing on the old one. Take its status as the truth.
          void get().applyIdleSettings().then(() => {
            if (get().status?.model.state !== 'loaded') {
              set({ capabilities: null })
            }
          })
          return
        }
      }
    },

    refreshStatus: async () => {
      try {
        set({ status: await diffusion().getStatus() })
      } catch (error) {
        console.error('[images] status unavailable:', error)
      }
    },

    refreshCatalog: async () => {
      try {
        const { catalog, source } = await fetchDiffusionCatalog()
        set({ catalog, catalogSource: source })
        recomputeInstalled()
      } catch (error) {
        console.error('[images] catalog unavailable:', error)
      }
    },

    refreshModelFiles: async () => {
      try {
        set({ modelFiles: await diffusion().listModelFiles() })
        recomputeInstalled()
      } catch (error) {
        console.error('[images] model files unavailable:', error)
      }
    },

    applyIdleSettings: async () => {
      try {
        set({ status: await configureCore() })
      } catch (error) {
        console.error('[images] idle settings not applied:', error)
      }
    },

    installEngine: async ({ force, family } = {}) => {
      if (get().engineInstall.inFlight) return
      const startedAt = Date.now()
      set({ engineInstall: { ...emptyInstall, inFlight: true } })
      captureImageEngineInstall({
        install_status: 'started',
        backend: get().hostBackendId,
        duration_ms: null,
        error_code: null,
      })
      try {
        const record = await ensureDiffusionBackend({
          force,
          ...(family ? { family } : {}),
          onProgress: ({ transferred, total }) =>
            set((state) => ({
              engineInstall: { ...state.engineInstall, transferred, total },
            })),
        })
        captureImageEngineInstall({
          install_status: 'completed',
          backend: record.backendId,
          duration_ms: Date.now() - startedAt,
          error_code: null,
        })
        await get().refreshStatus()
        set({ engineInstall: emptyInstall })
      } catch (error) {
        const described = toDiffusionError(error)
        set({ engineInstall: { ...emptyInstall, error: described } })
        captureImageEngineInstall({
          install_status: 'failed',
          backend: get().hostBackendId,
          duration_ms: Date.now() - startedAt,
          error_code: described.code,
        })
      }
    },

    checkEngineUpdate: async ({ force } = {}) => {
      const { status, hostBackendId, engineUpdate } = get()
      if (engineUpdate.checking) return
      if (status?.install.state !== 'installed' || !hostBackendId) {
        set({ engineUpdate: noUpdate })
        return
      }
      set({ engineUpdate: { ...engineUpdate, checking: true, error: null } })
      try {
        const pending = get().pendingEngineArtifactId
        const family = pending ? parseArtifactId(pending)?.family : undefined
        const { manifest, error } = await resolveSdcppManifest({
          force,
          ...(family ? { family } : {}),
        })
        const published = manifest.assets.some(
          (asset) => asset.backend === hostBackendId
        )
        const installedTag = status.install.tag
        set({
          engineUpdate: {
            checking: false,
            availableTag:
              published && manifest.tag_name !== installedTag
                ? manifest.tag_name
                : null,
            checkedAt: Date.now(),
            // A stale answer is still an answer; only note that it is stale.
            error: error ?? null,
          },
        })
      } catch (err) {
        set({
          engineUpdate: {
            ...get().engineUpdate,
            checking: false,
            checkedAt: Date.now(),
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    },

    updateEngine: async () => {
      if (
        updatingEngine ||
        !get().engineUpdate.availableTag ||
        get().engineInstall.inFlight
      )
        return
      updatingEngine = true
      const pending = get().pendingEngineArtifactId
      const family = pending ? parseArtifactId(pending)?.family : undefined
      try {
        // Forget retained idle/failed specs as well as resident servers.
        // The native finalizer also invalidates old sessions under load_lock.
        await diffusion().unloadModel()
        set({ capabilities: null })
        await get().installEngine({ ...(family ? { family } : {}) })
        if (get().engineInstall.error === null) {
          set({ engineUpdate: { ...noUpdate, checkedAt: Date.now() } })
          if (pending && get().pendingEngineArtifactId === pending)
            await get().loadModel(pending)
        } else {
          set({
            lastError: pending
              ? {
                  code: 'ENGINE_UPDATE_REQUIRED',
                  message:
                    get().engineInstall.error?.message ??
                    'Update the image engine and retry.',
                }
              : get().engineInstall.error,
          })
        }
      } catch (error) {
        set({ lastError: toDiffusionError(error) })
      } finally {
        updatingEngine = false
      }
    },

    loadModel: async (artifactId) => {
      const { catalog, modelFiles, paths } = get()
      if (!catalog || !paths) return
      const parsed = parseArtifactId(artifactId)
      const family = parsed ? findFamily(catalog, parsed.family) : undefined
      const quant =
        family && parsed ? findQuant(family, parsed.quantId) : undefined
      if (!parsed || !family || !quant) {
        set({
          lastError: {
            code: 'MODEL_MISSING',
            message: `Unknown model ${artifactId}.`,
          },
        })
        return
      }
      set({ pendingEngineArtifactId: null })
      const quantId = parsed.quantId
      const previousModelId = get().status?.model.loaded?.modelId ?? null
      const settings = useImageSetting.getState()
      const workflow = useImageForm.getState().workflow
      const teOnCpu = IS_MACOS
      const fit = fitForQuant(family, quant, hardwareProfile(), { teOnCpu })
      const requiredTextEncoders = family.text_encoders.filter(
        (file) =>
          file.field !== 'llm_vision' || workflowNeedsLlmVision(workflow)
      )
      const sideBytes =
        (family.vae?.bytes ?? 0) +
        (teOnCpu
          ? 0
          : requiredTextEncoders.reduce((sum, file) => sum + file.bytes, 0))

      set({ loadingArtifactId: artifactId, lastError: null })
      try {
        // Check live native status before evicting a chat model or launching.
        // Bundling a newer manifest does not upgrade existing profile binaries.
        const status = await diffusion().getStatus()
        set({ status })
        if (
          status.install.state === 'installed' &&
          !supportsDiffusionFamily(family.id, status.install.tag) &&
          !(await diffusion().listInstalledBackends()).some(
            (record) =>
              record.engine === 'sd-cpp' &&
              status.install.state === 'installed' &&
              record.backendId === status.install.backendId &&
              supportsDiffusionFamily(family.id, record.tag)
          )
        ) {
          set({
            pendingEngineArtifactId: artifactId,
            engineUpdate: {
              ...noUpdate,
              availableTag: MODERN_IMAGE_ENGINE_TAG,
              checkedAt: Date.now(),
            },
          })
          throw {
            code: 'ENGINE_UPDATE_REQUIRED',
            message: `${family.name} requires ${MODERN_IMAGE_ENGINE_TAG} or newer. Update the image engine and retry.`,
          }
        }
        await acquireGpuForDiffusion({
          requiredBytes: quant.bytes + sideBytes,
          policy: settings.evictChatModel,
        })
        const request = buildLoadRequest(
          family,
          quantId,
          modelFiles,
          paths.modelsRoot,
          {
            offload:
              settings.offloadOverride === 'auto'
                ? IS_MACOS && family.id === 'qwen-image'
                  ? // Qwen-Image's Wan VAE needs a large temporary decode
                    // buffer on Metal. Keeping the VAE on the GPU can produce
                    // a command-buffer page fault even when the static weights
                    // fit; the fault corrupts the first image and poisons the
                    // backend for every later request. Full model offload keeps
                    // the VAE on CPU while Metal still runs the denoiser.
                    'model'
                  : fit.policy
                : settings.offloadOverride,
            engine:
              settings.engineOverride === 'auto'
                ? undefined
                : settings.engineOverride,
            workflow,
          }
        )
        await diffusion().loadModel(request)
        const capabilities = await diffusion().getCapabilities()
        set({ capabilities })
        settings.setSelectedArtifactId(artifactId)
        if (previousModelId !== artifactId) {
          // A FLUX checkpoint at Qwen's old 30-step / high-guidance values
          // can overflow or produce garbage. Switching model families also
          // switches their numeric recipe, while keeping the user's prompt.
          useImageForm.getState().resetToDefaults(capabilities.defaults)
        }
        await get().refreshStatus()
      } catch (error) {
        const described = toDiffusionError(error)
        set({ lastError: described })
        if (described.code === 'ENGINE_UPDATE_REQUIRED') {
          set({
            pendingEngineArtifactId: artifactId,
            engineUpdate: {
              ...noUpdate,
              availableTag: MODERN_IMAGE_ENGINE_TAG,
              checkedAt: Date.now(),
            },
          })
        }
      } finally {
        set({ loadingArtifactId: null })
      }
    },

    unloadModel: async () => {
      const artifactId = get().status?.model.loaded?.modelId ?? null
      set({ unloadingArtifactId: artifactId, lastError: null })
      try {
        await diffusion().unloadModel()
        set({ capabilities: null })
        await get().refreshStatus()
      } catch (error) {
        set({ lastError: toDiffusionError(error) })
      } finally {
        set({ unloadingArtifactId: null })
      }
    },

    removeArtifact: async (artifactId) => {
      const { catalog, modelFiles, status } = get()
      if (!catalog) return
      const parsed = parseArtifactId(artifactId)
      const family = parsed ? findFamily(catalog, parsed.family) : undefined
      if (!parsed || !family) return
      if (status?.model.loaded?.modelId === artifactId) {
        await get().unloadModel()
      }
      await deleteArtifactFiles(family, parsed.quantId, modelFiles, catalog)
      const settings = useImageSetting.getState()
      if (settings.selectedArtifactId === artifactId) {
        settings.setSelectedArtifactId(null)
      }
      await get().refreshModelFiles()
    },

    startGeneration: async ({ request, runs, baseSeed }) => {
      if (get().generating) return
      const capabilities = get().capabilities
      if (capabilities) {
        const verdict = validateImageRequest(request, capabilities)
        if (!verdict.ok) {
          set({ lastError: { code: verdict.code, message: verdict.message } })
          return
        }
      }
      const runsTotal = Math.max(1, Math.floor(runs))
      useImageGalleryStore.getState().selectLive()
      set({
        generating: true,
        generationStartedAtMs: Date.now(),
        runsTotal,
        runsDone: 0,
        stopRequested: false,
        lastError: null,
      })
      let produced = 0
      try {
        for (let run = 0; run < runsTotal; run += 1) {
          if (get().stopRequested) break
          // Each run gets its own seed range so the batches do not repeat:
          // run N starts where run N-1's last image left off.
          const seed =
            baseSeed === null ? undefined : baseSeed + run * request.batchSize
          let jobId: string
          try {
            const submitted = await diffusion().generate({ ...request, seed })
            jobId = submitted.jobId
          } catch (error) {
            set({ lastError: toDiffusionError(error) })
            break
          }
          set({ currentJob: placeholderJob(jobId) })
          const job = await waitForTerminal(jobId)
          reportJob(job, runsTotal)
          if (job.state === 'completed') {
            useImageGalleryStore.getState().prepend(job.outputs)
            produced += job.outputs.length
            set({ runsDone: run + 1 })
          } else if (
            job.error &&
            shouldReportGenerateError({
              code: job.error.code,
              stopRequested: get().stopRequested,
            })
          ) {
            set({ lastError: job.error })
          }
          if (
            !shouldContinueGenerating({
              stopRequested: get().stopRequested,
              jobState: job.state,
              run,
              runsTotal,
            })
          ) {
            break
          }
        }
      } finally {
        set({
          currentJob: null,
          generating: false,
          generationStartedAtMs: null,
        })
        notifyIfUnfocused(produced)
      }
    },

    stop: async () => {
      const job = get().currentJob
      set({ stopRequested: true })
      if (!job) return
      try {
        await diffusion().cancelJob(job.id)
      } catch (error) {
        console.error('[images] cancel failed:', error)
      }
    },

    clearError: () => set({ lastError: null }),

    openSetup: (step = 0) => set({ setupOpen: true, setupStep: step }),
    closeSetup: () => set({ setupOpen: false }),

    reset: () => {
      waiters.clear()
      set({ ...initial })
    },
  }
})

/**
 * Every setting the core must be given again on each configure, for
 * `configureDiffusion`: it keeps them only in memory and replaces all of them
 * at once, so a setting left out here is reset to the core's default.
 */
function coreSettings(): { idleUnloadSecs: number; outputDir?: string } {
  const { keepModelLoaded, idleUnloadMinutes, outputDir } =
    useImageSetting.getState()
  const folder = typeof outputDir === 'string' ? outputDir.trim() : ''
  return {
    idleUnloadSecs: keepModelLoaded ? 0 : idleUnloadMinutes * 60,
    ...(folder ? { outputDir: folder } : {}),
  }
}

/**
 * Configure the core with `coreSettings`. A stored folder the core can no
 * longer create (a drive that is not plugged in) must not take image
 * generation down: configure again without it, which means the default
 * folder, and keep the choice for the next configure.
 */
async function configureCore(): Promise<DiffusionStatus> {
  const settings = coreSettings()
  try {
    return await configureDiffusion(settings)
  } catch (error) {
    if (settings.outputDir === undefined || !isFolderFailure(error)) throw error
    console.warn(
      `[images] output folder ${settings.outputDir} not usable, using the default:`,
      error
    )
    return configureDiffusion({ idleUnloadSecs: settings.idleUnloadSecs })
  }
}

/**
 * How the core reports a folder it cannot create: an I/O failure (INTERNAL) or
 * a full disk. A core that is down, or that refuses the data folder, fails the
 * same way without the folder, so retrying would only hide the real error.
 */
function isFolderFailure(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined
  return code === 'INTERNAL' || code === 'DISK_FULL'
}

/** Test seam: drop the waiters of a previous test. */
export function resetImageGenerationForTests(): void {
  useImageGenerationStore.getState().reset()
}

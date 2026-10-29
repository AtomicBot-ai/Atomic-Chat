import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { getServiceHub } from '@/hooks/useServiceHub'
import { i18n } from '@/i18n/react-i18next-compat'
import {
  diffusionDownloadTaskId,
  downloadArtifact,
  parseArtifactId,
} from '@/lib/diffusion/models'
import {
  cancelDownload,
  isDownloadCancellationError,
  wasDownloadCancellationRequested,
} from '@/lib/downloadCancellation'
import { pauseDownload } from '@/lib/downloadControls'
import type { OnboardingJob } from '@/lib/onboarding/jobs'
import {
  DIFFUSION_ENGINE_TASK_PREFIX,
  isDiffusionEngineTaskId,
} from '@/services/diffusion/engine'
import {
  findFamily,
  findQuant,
  type DiffusionCatalogFamily,
} from '@/services/diffusion-catalog-registry'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useOnboardingStore } from '@/stores/onboarding-store'

/**
 * Where a job points before the engine's own download row exists: an id of
 * the engine's kind that no transfer carries, so the strip reads "Starting…"
 * and offers no Pause (engine installs are cancel-only).
 */
const ENGINE_PENDING_TASK_ID = `${DIFFUSION_ENGINE_TASK_PREFIX}pending`

type Watchable<T> = {
  getState: () => T
  subscribe: (listener: (state: T) => void) => () => void
}

/** Resolves once `done` holds for `store`: now, or at a later change. */
function until<T>(
  store: Watchable<T>,
  done: (state: T) => boolean
): Promise<void> {
  return new Promise((resolve) => {
    if (done(store.getState())) {
      resolve()
      return
    }
    const unsubscribe = store.subscribe((state) => {
      if (!done(state)) return
      unsubscribe()
      resolve()
    })
  })
}

const queuedJob = (key: string): OnboardingJob | undefined =>
  useOnboardingStore.getState().jobs.find((job) => job.key === key)

type JobPointer = Partial<
  Pick<OnboardingJob, 'taskId' | 'title' | 'totalBytes'>
>

/**
 * Points the queued job at another download row, which the strip then shows.
 * A job taken off the queue meanwhile stays off.
 */
function pointJob(key: string, pointer: JobPointer): void {
  const job = queuedJob(key)
  if (!job) return
  const moved = { ...job, ...pointer }
  if (
    moved.taskId === job.taskId &&
    moved.title === job.title &&
    moved.totalBytes === job.totalBytes
  ) {
    return
  }
  useOnboardingStore.getState().enqueue(moved)
}

const engineInstalled = (): boolean =>
  useImageGenerationStore.getState().status?.install.state === 'installed'

/**
 * The strip shows one row per job, by its `taskId`. While the engine installs
 * there is no model transfer to show, so the job points at the engine's row in
 * the download store — its bytes, percent and estimate — under "Image engine
 * for <model>", and back at the model's own row once the install is over.
 * Returns that way back.
 */
function showEngineInstall(
  key: string,
  title: string,
  modelTaskId: string
): () => void {
  const engineTitle = i18n.t('onboarding-media:engineTitle', { name: title })
  const totalBytes = queuedJob(key)?.totalBytes
  pointJob(key, {
    taskId: ENGINE_PENDING_TASK_ID,
    title: engineTitle,
    totalBytes: undefined,
  })
  const follow = ({ downloads }: { downloads: Record<string, unknown> }) => {
    const engineTaskId = Object.keys(downloads).find(isDiffusionEngineTaskId)
    if (engineTaskId) pointJob(key, { taskId: engineTaskId })
  }
  follow(useDownloadStore.getState())
  const unsubscribe = useDownloadStore.subscribe(follow)
  return () => {
    unsubscribe()
    pointJob(key, { taskId: modelTaskId, title, totalBytes })
  }
}

/**
 * Installs the image engine unless it is there. An install already under way
 * — started from the Images page — is waited for rather than started twice.
 * `false` when it did not install; a cancel from the download panel leaves no
 * error behind and is not logged, being the user's choice.
 */
async function ensureEngine(
  key: string,
  title: string,
  modelTaskId: string
): Promise<boolean> {
  if (!useImageGenerationStore.getState().status) {
    await useImageGenerationStore.getState().refreshStatus()
  }
  if (engineInstalled()) return true
  const back = showEngineInstall(key, title, modelTaskId)
  try {
    if (useImageGenerationStore.getState().engineInstall.inFlight) {
      await until(
        useImageGenerationStore,
        (state) => !state.engineInstall.inFlight
      )
    } else {
      await useImageGenerationStore.getState().installEngine()
    }
  } finally {
    back()
  }
  if (engineInstalled()) return true
  const { error } = useImageGenerationStore.getState().engineInstall
  if (error) console.error('[onboarding] image engine install failed:', error)
  return false
}

/** The model's row is in the download store, running or paused. */
const tracked = (taskId: string): boolean => {
  const { downloads, pausedDownloads } = useDownloadStore.getState()
  return pausedDownloads.has(taskId) || taskId in downloads
}

/**
 * Taking the card off the queue while its model downloads stops the transfer
 * the way the panel's Cancel does, paused or not. A transfer that only got
 * going after the card was taken off is stopped at its first progress frame.
 */
function watchRemoval(key: string, taskId: string) {
  let removed = false
  let stopped = false
  const stop = () => {
    if (stopped || !tracked(taskId)) return
    stopped = true
    cancelDownload({ id: taskId, name: taskId }, getServiceHub())
  }
  const unsubscribe = useOnboardingStore.subscribe(({ jobs }) => {
    if (removed || jobs.some((job) => job.key === key)) return
    removed = true
    stop()
  })
  return {
    removed: () => removed,
    onProgress: () => {
      if (removed) stop()
    },
    dispose: unsubscribe,
  }
}

/** The run's chat model is not over: queued, running, paused or interrupted. */
const chatModelPending = (jobs: readonly OnboardingJob[]): boolean =>
  jobs.some((job) => job.kind === 'chat' && job.phase !== 'done')

/**
 * The chat model goes first, as in the prototype. A chat download chosen
 * while this job was under way — the user went back to the model step — is
 * waited for, the job back in the queue meanwhile, before this job's model
 * file starts. An engine install already running is not stopped: it cannot
 * be paused.
 */
async function waitForChatModel(key: string): Promise<void> {
  const waiting = ({ jobs }: { jobs: OnboardingJob[] }) =>
    chatModelPending(jobs) && jobs.some((job) => job.key === key)
  if (!waiting(useOnboardingStore.getState())) return
  useOnboardingStore.getState().setJobPhase(key, 'queued')
  await until(useOnboardingStore, (state) => !waiting(state))
  if (queuedJob(key)?.phase === 'queued') {
    useOnboardingStore.getState().setJobPhase(key, 'running')
  }
}

/**
 * The same for a model file already downloading: a chat download chosen now
 * pauses it and puts the job back in the queue, and once the chat model is
 * over the transfer picks up where it stopped, quietly. A pause of the
 * user's own is theirs to resume. The pause is checked again at each
 * progress frame, for a chat download chosen before this transfer's row
 * existed.
 */
function yieldToChatModel(
  key: string,
  family: DiffusionCatalogFamily,
  quantId: string,
  taskId: string
) {
  let yielded = false
  const check = () => {
    const { jobs } = useOnboardingStore.getState()
    if (!jobs.some((job) => job.key === key)) return
    const pending = chatModelPending(jobs)
    if (pending && !yielded) {
      const { downloads, pausedDownloads } = useDownloadStore.getState()
      if (!(taskId in downloads) || pausedDownloads.has(taskId)) return
      yielded = true
      useOnboardingStore.getState().setJobPhase(key, 'queued')
      pauseDownload({ id: taskId, name: taskId }, getServiceHub())
    } else if (!pending && yielded) {
      yielded = false
      useOnboardingStore.getState().setJobPhase(key, 'running')
      const downloads = useDownloadStore.getState()
      downloads.clearPausedDownload(taskId)
      downloads.markResumableDownload(taskId)
      // The row it reopens is followed to its end by `downloadModel`.
      void downloadArtifact(family, quantId, {
        resume: true,
        hfToken: useGeneralSetting.getState().huggingfaceToken,
      }).catch((error: unknown) =>
        console.error('[onboarding] media download did not resume:', error)
      )
    }
  }
  return {
    onProgress: check,
    dispose: useOnboardingStore.subscribe(check),
  }
}

/**
 * Downloads the job's model file — or follows the transfer of it already in
 * the download store — to its end, and re-lists the model files.
 */
async function downloadModel(
  job: OnboardingJob,
  family: DiffusionCatalogFamily,
  quantId: string,
  modelTaskId: string
): Promise<boolean> {
  const artifact = job.artifactId ?? ''
  const removal = watchRemoval(job.key, modelTaskId)
  const chatFirst = yieldToChatModel(job.key, family, quantId, modelTaskId)
  try {
    try {
      // A row already here is this model's transfer driven from elsewhere —
      // paused before a relaunch, or started on the Images page — and is
      // followed below rather than started a second time.
      if (!tracked(modelTaskId)) {
        // `resume`: a retry picks up the bytes a pause or a failure left.
        await downloadArtifact(family, quantId, {
          resume: true,
          hfToken: useGeneralSetting.getState().huggingfaceToken,
          onProgress: () => {
            removal.onProgress()
            chatFirst.onProgress()
          },
        })
        await useImageGenerationStore.getState().refreshModelFiles()
        return true
      }
    } catch (error) {
      // Pause stops the transfer but keeps its row: the job waits for the
      // Resume, as the chat model's does, instead of failing.
      if (!tracked(modelTaskId)) {
        if (
          removal.removed() ||
          wasDownloadCancellationRequested(modelTaskId) ||
          isDownloadCancellationError(error)
        ) {
          return false
        }
        console.error('[onboarding] media download failed:', job.key, error)
        return false
      }
    }
    // Until the row closes — finished, failed or cancelled — and then the
    // files on disk tell which.
    await until(
      useDownloadStore,
      ({ downloads, pausedDownloads }) =>
        !pausedDownloads.has(modelTaskId) && !(modelTaskId in downloads)
    )
    await useImageGenerationStore.getState().refreshModelFiles()
    return useImageGenerationStore
      .getState()
      .installedArtifacts.some(
        (installed) => installed.id === artifact && installed.complete
      )
  } finally {
    removal.dispose()
    chatFirst.dispose()
  }
}

/**
 * Runs one image or video job of a first run: installs the image engine when
 * it is missing, then downloads the job's model file (`artifactId`) and
 * re-lists the model files, so the Images and Video pages see it. Resolves
 * `true` once the file is in place, `false` when it failed, was cancelled or
 * was taken off the queue; it never rejects. A paused download keeps the
 * promise pending until it is resumed and over. `OnboardingRuntime` calls it
 * for jobs of kind image and video, one at a time, after the chat model; it
 * starts nothing but this job.
 *
 * While the engine installs, the job points at the engine's download row (see
 * `showEngineInstall`), so the strip has that progress to show.
 */
export async function startMediaJob(job: OnboardingJob): Promise<boolean> {
  try {
    const target = job.artifactId ? parseArtifactId(job.artifactId) : null
    if (!job.artifactId || !target) {
      console.error('[onboarding] media job without a model file:', job.key)
      return false
    }
    if (!queuedJob(job.key)) return false
    if (!useImageGenerationStore.getState().catalog) {
      await useImageGenerationStore.getState().refreshCatalog()
    }
    const catalog = useImageGenerationStore.getState().catalog
    const family = catalog ? findFamily(catalog, target.family) : undefined
    if (!family || !findQuant(family, target.quantId)) {
      console.error('[onboarding] media model not in the catalog:', job.key)
      return false
    }
    const modelTaskId = diffusionDownloadTaskId(job.artifactId)
    // A run quit during the engine install comes back pointing at it.
    pointJob(job.key, { taskId: modelTaskId, title: family.name })

    if (!(await ensureEngine(job.key, family.name, modelTaskId))) return false
    await waitForChatModel(job.key)
    if (!queuedJob(job.key)) return false
    return await downloadModel(job, family, target.quantId, modelTaskId)
  } catch (error) {
    console.error('[onboarding] media job failed:', job.key, error)
    return false
  }
}

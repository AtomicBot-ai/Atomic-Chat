import {
  isAnswerableModel,
  type AnswerableModelLike,
} from '@/lib/answerable-model'
import { sanitizeMlxId } from '@/lib/hub-installed'
import { sanitizeModelId } from '@/lib/utils'

/**
 * The downloads a first run queues: its chat model first, then the image and
 * video models it offered. One runs at a time, in order, like the prototype.
 *
 * A job stores only what it is and where it stands in the queue. Bytes, speed
 * and Pause live in `useDownloadStore` under `taskId`, so the setup screen, the
 * panel and the model picker can never disagree about a figure. The one
 * exception is where an interrupted transfer stopped, which the failure takes
 * out of the store (`OnboardingJob.stoppedAt`).
 */
export type OnboardingJobKind = 'chat' | 'image' | 'video'

export type OnboardingJobPhase = 'queued' | 'running' | 'done' | 'failed'

/** How far a transfer got, as the download store reports it. */
export type JobTransfer = { progress: number; current: number; total: number }

export type OnboardingJob = {
  /** Stable within a run: the chat model, or the media family. */
  key: string
  kind: OnboardingJobKind
  title: string
  /** The id the download store and the download panel know it by. */
  taskId: string
  /** Bytes to fetch, when known before the first progress event. */
  totalBytes?: number
  /** An image/video job's model file, as `family:quantId` (`lib/diffusion`). */
  artifactId?: string
  phase: OnboardingJobPhase
  /**
   * Where the transfer of `taskId` stood when it was interrupted. A failure
   * takes the row out of the download store, and the progress with it; the
   * job keeps it until the transfer reports again (`OnboardingRuntime`).
   */
  stoppedAt?: JobTransfer & { taskId: string }
}

/** What a job looks like on screen. */
export type OnboardingJobState =
  | 'queued'
  | 'preparing'
  | 'downloading'
  | 'paused'
  | 'interrupted'
  | 'done'

export type OnboardingJobView = {
  state: OnboardingJobState
  /** 0–100, floored, so 99.6% never reads as done. */
  percent: number
  /** 0–1, as the download store reports it, for the readout. */
  progress: number
  currentBytes: number
  totalBytes: number
}

/** The slice of `useDownloadStore` a job's view depends on. */
export type DownloadSnapshot = {
  downloads: Record<string, JobTransfer | undefined>
  pausedDownloads: ReadonlySet<string>
}

/**
 * The job's transfer: its row in the download store, or, once a failure took
 * the row away, where it stopped — through a Retry too, until the resumed
 * transfer reports.
 */
function transferOf(
  job: OnboardingJob,
  snapshot: DownloadSnapshot
): JobTransfer | undefined {
  return (
    snapshot.downloads[job.taskId] ??
    (job.stoppedAt?.taskId === job.taskId ? job.stoppedAt : undefined)
  )
}

export function jobView(
  job: OnboardingJob,
  snapshot: DownloadSnapshot
): OnboardingJobView {
  const download = transferOf(job, snapshot)
  const totalBytes = download?.total || job.totalBytes || 0
  if (job.phase === 'done') {
    return {
      state: 'done',
      percent: 100,
      progress: 1,
      currentBytes: totalBytes,
      totalBytes,
    }
  }
  const currentBytes = download?.current ?? 0
  const progress = download?.progress ?? 0
  const percent = download ? Math.min(99, Math.floor(progress * 100)) : 0
  const state: OnboardingJobState =
    job.phase === 'queued'
      ? 'queued'
      : job.phase === 'failed'
        ? 'interrupted'
        : snapshot.pausedDownloads.has(job.taskId)
          ? 'paused'
          : download && download.current > 0
            ? 'downloading'
            : 'preparing'
  return { state, percent, progress, currentBytes, totalBytes }
}

/**
 * The job to start now, or `null` while one is still in flight. A paused or
 * failed job holds the queue: the user resumes or retries it first, so a large
 * video download never overtakes the chat model they are waiting for.
 */
export function nextRunnable(
  jobs: readonly OnboardingJob[]
): OnboardingJob | null {
  if (jobs.some((job) => job.phase === 'running' || job.phase === 'failed')) {
    return null
  }
  return jobs.find((job) => job.phase === 'queued') ?? null
}

/** Nothing of this run is still queued, running or waiting for a retry. */
export function queueSettled(jobs: readonly OnboardingJob[]): boolean {
  return jobs.every((job) => job.phase === 'done')
}

/**
 * The provider model ids a Hub GGUF can end up registered under: its own id,
 * or the developer-qualified sanitized one the importer writes.
 */
export function ggufMatchIds(
  developer: string | undefined,
  modelId: string
): string[] {
  return [
    ...new Set([
      modelId,
      ...(developer ? [`${developer}/${sanitizeModelId(modelId)}`] : []),
    ]),
  ]
}

/**
 * The same for an MLX catalog model. The MLX engine keeps dots and turns
 * spaces into `-`, unlike `sanitizeModelId`.
 */
export function mlxMatchIds(
  developer: string | undefined,
  modelName: string
): string[] {
  const id = sanitizeMlxId(modelName.split('/').pop() ?? modelName)
  return [...new Set([id, ...(developer ? [`${developer}/${id}`] : [])])]
}

type ProviderLike = {
  provider: string
  active?: boolean
  models: ReadonlyArray<AnswerableModelLike & { id: string }>
}

/** The chosen chat model, as the onboarding store keeps it. */
export type ChatModelRef = { provider: string; matchIds: readonly string[] }

/**
 * The provider model the chosen chat model registered as, once it can answer:
 * downloaded, imported or already in the library.
 */
export function findChatModel(
  choice: ChatModelRef | null,
  providers: readonly ProviderLike[]
): { provider: string; modelId: string } | null {
  if (!choice) return null
  const provider = providers.find(
    (candidate) =>
      candidate.provider === choice.provider && candidate.active !== false
  )
  const model = provider?.models.find(
    (candidate) =>
      choice.matchIds.includes(candidate.id) && isAnswerableModel(candidate)
  )
  return model ? { provider: choice.provider, modelId: model.id } : null
}

/** The slice of the onboarding store the handoff panel decides on. */
export type HandoffRun = {
  phase: string
  destination: string | null
  panelDismissed: boolean
  jobs: readonly OnboardingJob[]
}

/**
 * The panel the app shows after a handoff to the chat is following the run's
 * downloads: something is still queued, running or waiting for a retry, and
 * the user has not dismissed it. Meanwhile the global download panel leaves
 * those downloads to it, so no row is shown twice.
 */
export function handoffPanelTracksJobs(run: HandoffRun): boolean {
  return (
    run.phase === 'handedOff' &&
    run.destination === 'chat' &&
    !run.panelDismissed &&
    !queueSettled(run.jobs)
  )
}

/** What the handoff panel has to say: the downloads, or the model ready. */
export type HandoffPanelContent = 'downloads' | 'ready'

/**
 * Whether the handoff panel shows, and what for. It follows the run's
 * downloads after a handoff to the chat; once they are over — or were over
 * before the handoff — it says the chosen model is ready, until dismissed.
 * The ready note belongs to the app session that handed off or followed a
 * download (`seenInApp`): a later launch with nothing left to follow brings
 * no news, and the run ends without it.
 */
export function handoffPanelContent(
  run: HandoffRun,
  { ready, seenInApp }: { ready: boolean; seenInApp: boolean }
): HandoffPanelContent | null {
  if (handoffPanelTracksJobs(run)) return 'downloads'
  return seenInApp &&
    ready &&
    run.phase === 'handedOff' &&
    run.destination === 'chat' &&
    !run.panelDismissed
    ? 'ready'
    : null
}

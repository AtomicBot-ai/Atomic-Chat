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
 * panel and the model picker can never disagree about a figure.
 */
export type OnboardingJobKind = 'chat' | 'image' | 'video'

export type OnboardingJobPhase = 'queued' | 'running' | 'done' | 'failed'

export type OnboardingJob = {
  /** Stable within a run: the chat model, or the media family. */
  key: string
  kind: OnboardingJobKind
  title: string
  /** The id the download store and the download panel know it by. */
  taskId: string
  /** Bytes to fetch, when known before the first progress event. */
  totalBytes?: number
  phase: OnboardingJobPhase
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
  currentBytes: number
  totalBytes: number
}

/** The slice of `useDownloadStore` a job's view depends on. */
export type DownloadSnapshot = {
  downloads: Record<
    string,
    { progress: number; current: number; total: number } | undefined
  >
  pausedDownloads: ReadonlySet<string>
}

export function jobView(
  job: OnboardingJob,
  snapshot: DownloadSnapshot
): OnboardingJobView {
  const download = snapshot.downloads[job.taskId]
  const totalBytes = download?.total || job.totalBytes || 0
  if (job.phase === 'done') {
    return {
      state: 'done',
      percent: 100,
      currentBytes: totalBytes,
      totalBytes,
    }
  }
  const currentBytes = download?.current ?? 0
  const percent = download
    ? Math.min(99, Math.floor(download.progress * 100))
    : 0
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
  return { state, percent, currentBytes, totalBytes }
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

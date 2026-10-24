import { useDownloadStore } from '@/hooks/useDownloadStore'
import {
  jobView,
  type OnboardingJob,
  type OnboardingJobView,
} from '@/lib/onboarding/jobs'
import { useOnboardingStore } from '@/stores/onboarding-store'

/** What the model picker says while the run's chat model is on its way. */
export type PendingModelStatus = 'downloading' | 'paused' | 'interrupted'

export type PendingOnboardingModel = {
  job: OnboardingJob
  view: OnboardingJobView
  status: PendingModelStatus
}

const statusOf = (view: OnboardingJobView): PendingModelStatus =>
  view.state === 'paused'
    ? 'paused'
    : view.state === 'interrupted'
      ? 'interrupted'
      : 'downloading'

/**
 * The first run's chat model while it is not ready yet: its job, where its
 * download stands, and what the composer's picker says about it. `null` once
 * the model is ready, or when the run downloads none. Figures come from the
 * download store, the same ones the run's strip and the download panel show.
 */
export function usePendingOnboardingModel(): PendingOnboardingModel | null {
  const job = useOnboardingStore((state) =>
    state.jobs.find((candidate) => candidate.kind === 'chat')
  )
  const taskId = job?.taskId
  const download = useDownloadStore((state) =>
    taskId ? state.downloads[taskId] : undefined
  )
  const paused = useDownloadStore((state) =>
    taskId ? state.pausedDownloads.has(taskId) : false
  )
  if (!job || job.phase === 'done') return null
  const view = jobView(job, {
    downloads: download ? { [job.taskId]: download } : {},
    pausedDownloads: new Set(paused ? [job.taskId] : []),
  })
  return { job, view, status: statusOf(view) }
}

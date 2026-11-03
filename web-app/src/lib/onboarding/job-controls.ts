/**
 * Pause, Resume and Retry for a first run's downloads, shared by the run's
 * strip (setup screen and handoff panel) and the composer's model picker, so
 * every place offers them the same way.
 */

import {
  useDownloadStore,
  type DownloadResumeParams,
} from '@/hooks/useDownloadStore'
import { pauseDownload } from '@/lib/downloadControls'
import { resumeDownload } from '@/lib/downloadResume'
import type { OnboardingJob } from '@/lib/onboarding/jobs'
import type { ServiceHub } from '@/services'
import { useOnboardingStore } from '@/stores/onboarding-store'

type Translate = (key: string, options?: Record<string, unknown>) => string

type ControlDeps = { serviceHub: ServiceHub; t: Translate }

/**
 * The parameters each chat-model file of a run started with. A download that
 * fails loses its parameters in the store (`DownloadManagement`), which would
 * leave Retry nothing to resume from: `OnboardingRuntime` keeps a copy here
 * while the download runs. Memory only, like the store's own; after a
 * relaunch only a paused download comes back with its parameters.
 */
const knownResumeParams = new Map<string, DownloadResumeParams>()

export function rememberResumeParams(
  taskId: string,
  params: DownloadResumeParams
): void {
  knownResumeParams.set(taskId, params)
}

const downloadOf = (job: OnboardingJob) => ({
  id: job.taskId,
  name: useDownloadStore.getState().downloads[job.taskId]?.name ?? job.taskId,
})

export function pauseOnboardingJob(
  job: OnboardingJob,
  serviceHub: ServiceHub
): void {
  pauseDownload(downloadOf(job), serviceHub)
}

/**
 * Resume a paused job where it stopped. An image or video job's
 * `startMediaJob` is still waiting through the pause, and settles the job
 * once the resumed transfer ends.
 */
export function resumeOnboardingJob(
  job: OnboardingJob,
  deps: ControlDeps
): void {
  resumeDownload(downloadOf(job), deps)
}

/**
 * Start a stopped chat-model file again from the bytes on disk. Returns
 * `false` when nothing here can: its parameters are gone (an MLX repository
 * has none, and a failed download's are lost with a relaunch).
 */
export function resumeChatJob(job: OnboardingJob, deps: ControlDeps): boolean {
  const store = useDownloadStore.getState()
  if (!store.resumeParams[job.taskId]) {
    const known = knownResumeParams.get(job.taskId)
    if (!known) return false
    store.setResumeParams(job.taskId, known)
  }
  // A failed download's row is gone; show it again before the first byte,
  // as a fresh start does.
  if (!(job.taskId in store.downloads)) {
    store.addLocalDownloadingModel(job.taskId)
  }
  useOnboardingStore.getState().setJobPhase(job.key, 'running')
  resumeDownload(downloadOf(job), deps)
  return true
}

/**
 * Retry an interrupted chat job, or one a Retry put back in the queue. When
 * it cannot be resumed, `resumeDownload` tells the user to download it again
 * from its card and the run stops waiting for it, so the rest of the queue
 * goes on.
 */
export function restartChatJob(job: OnboardingJob, deps: ControlDeps): void {
  if (resumeChatJob(job, deps)) return
  resumeDownload(downloadOf(job), deps)
  useOnboardingStore.getState().dequeue(job.key)
}

/**
 * Retry an interrupted job: the chat model resumes at once; an image or video
 * job goes back into the queue for the runtime to start again.
 */
export function retryOnboardingJob(
  job: OnboardingJob,
  deps: ControlDeps
): void {
  if (job.kind === 'chat') {
    restartChatJob(job, deps)
    return
  }
  useOnboardingStore.getState().setJobPhase(job.key, 'queued')
}

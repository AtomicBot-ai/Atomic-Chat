import { useEffect, useMemo, useRef, useState } from 'react'
import { DownloadEvent, events, type DownloadState } from '@janhq/core'

import { localStorageKey } from '@/constants/localStorage'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  isDownloadCancellationError,
  wasDownloadCancellationRequested,
} from '@/lib/downloadCancellation'
import {
  rememberResumeParams,
  restartChatJob,
} from '@/lib/onboarding/job-controls'
import {
  findChatModel,
  handoffPanelContent,
  nextRunnable,
  queueSettled,
  type JobTransfer,
  type OnboardingJob,
} from '@/lib/onboarding/jobs'
import { startMediaJob } from '@/lib/onboarding/media-jobs'
import { useOnboardingStore } from '@/stores/onboarding-store'

import { OnboardingHandoffPanel } from './OnboardingHandoffPanel'

/**
 * The image and video jobs this app session started and is still following
 * to the end. Module-level, so a remount never starts one twice, and a job an
 * earlier session left running — nothing follows it any more — is told apart.
 */
const following = new Set<string>()

/** The run's chat job while its download is under way. */
const runningChatJob = (taskId: string): OnboardingJob | undefined =>
  useOnboardingStore
    .getState()
    .jobs.find(
      (job) =>
        job.kind === 'chat' && job.taskId === taskId && job.phase === 'running'
    )

/** A chat download the user stopped for good: the run lets go of it. */
const dropCancelledChatJob = (job: OnboardingJob) =>
  useOnboardingStore.getState().dequeue(job.key)

/**
 * What a first run does for as long as it lasts, on every route: it follows
 * the chat model's download to the library, runs the image and video jobs
 * after it one at a time, and after the handoff puts the model where the user
 * will look for it — the composer, or the Local API Server — and shows the
 * handoff panel while the downloads finish and to say the model is ready.
 * Once nothing is left on screen, the run is finished.
 *
 * Mounted once in `AppLayout`, so the queue keeps going whichever page is
 * open, the setup screen included.
 */
export function OnboardingRuntime() {
  const serviceHub = useServiceHub()
  const { t } = useTranslation()
  const phase = useOnboardingStore((state) => state.phase)
  const jobs = useOnboardingStore((state) => state.jobs)
  const choice = useOnboardingStore((state) => state.choice)
  const destination = useOnboardingStore((state) => state.destination)
  const guide = useOnboardingStore((state) => state.guide)
  const panelDismissed = useOnboardingStore((state) => state.panelDismissed)
  const providers = useModelProvider((state) => state.providers)
  const selectedModel = useModelProvider((state) => state.selectedModel)

  const ready = useMemo(
    () => findChatModel(choice, providers),
    [choice, providers]
  )
  const chat = jobs.find((job) => job.kind === 'chat')

  // The chat model finished downloading or importing.
  useEffect(() => {
    if (chat && chat.phase !== 'done' && ready) {
      useOnboardingStore.getState().setJobPhase(chat.key, 'done')
    }
  }, [chat, ready])

  // A chat download that fails is interrupted, with Retry. A pause is not a
  // failure: the job stays where it is with Resume. Neither is a cancel from
  // the download panel or the Downloads page: the user removed the download,
  // so the run stops waiting for it. MLX repositories report through
  // `startMlxCatalogDownload`, which settles the job itself.
  useEffect(() => {
    const onError = (state: DownloadState) => {
      const job = runningChatJob(state.modelId)
      if (!job) return
      const error = (state as unknown as { error?: string }).error ?? ''
      const cancelled = isDownloadCancellationError(error)
      if (
        cancelled &&
        useDownloadStore.getState().pausedDownloads.has(state.modelId)
      ) {
        return
      }
      if (cancelled || wasDownloadCancellationRequested(state.modelId)) {
        dropCancelledChatJob(job)
        return
      }
      useOnboardingStore.getState().setJobPhase(job.key, 'failed')
    }
    const onStopped = (state: DownloadState) => {
      const job = runningChatJob(state.modelId)
      if (!job) return
      if (useDownloadStore.getState().pausedDownloads.has(state.modelId)) return
      dropCancelledChatJob(job)
    }
    const onValidationFailed = (event: { modelId: string }) => {
      const job = runningChatJob(event.modelId)
      if (job) useOnboardingStore.getState().setJobPhase(job.key, 'failed')
    }
    events.on(DownloadEvent.onFileDownloadError, onError)
    events.on(DownloadEvent.onFileDownloadStopped, onStopped)
    events.on(DownloadEvent.onModelValidationFailed, onValidationFailed)
    return () => {
      events.off(DownloadEvent.onFileDownloadError, onError)
      events.off(DownloadEvent.onFileDownloadStopped, onStopped)
      events.off(DownloadEvent.onModelValidationFailed, onValidationFailed)
    }
  }, [])

  // Retry resumes from the parameters the download started with, which a
  // failure takes out of the store: keep a copy while it runs.
  const chatTaskId = chat?.taskId
  const chatResumeParams = useDownloadStore((state) =>
    chatTaskId ? state.resumeParams[chatTaskId] : undefined
  )
  useEffect(() => {
    if (chatTaskId && chatResumeParams) {
      rememberResumeParams(chatTaskId, chatResumeParams)
    }
  }, [chatTaskId, chatResumeParams])

  // After a relaunch nothing follows what the last session left running. An
  // image or video job goes back into the queue to start again; a chat
  // download the download store did not bring back as paused (an MLX
  // repository) is interrupted, with Retry. Decided once the providers are
  // known, so a model that landed meanwhile counts as landed.
  const reconciledRef = useRef(false)
  useEffect(() => {
    if (reconciledRef.current || providers.length === 0) return
    reconciledRef.current = true
    const run = useOnboardingStore.getState()
    const downloads = useDownloadStore.getState()
    for (const job of run.jobs) {
      if (job.phase !== 'running') continue
      if (job.kind !== 'chat') {
        if (!following.has(job.key)) run.setJobPhase(job.key, 'queued')
        continue
      }
      const inFlight =
        job.taskId in downloads.downloads ||
        downloads.localDownloadingModels.has(job.taskId)
      if (!inFlight && !findChatModel(run.choice, providers)) {
        run.setJobPhase(job.key, 'failed')
      }
    }
  }, [providers])

  // The queue: one job at a time, in order, during setup and after it. Read
  // from the store, not the render: a job started a moment ago is running
  // there already.
  useEffect(() => {
    if (phase !== 'active' && phase !== 'handedOff') return
    const job = nextRunnable(useOnboardingStore.getState().jobs)
    if (!job || following.has(job.key)) return
    if (job.kind === 'chat') {
      // Only a Retry puts the chat model back in the queue; it picks up
      // where its download stopped.
      restartChatJob(job, { serviceHub, t })
      return
    }
    // Followed by key only: while it installs the image engine, the job
    // shows that download under its own task id and title.
    following.add(job.key)
    useOnboardingStore.getState().setJobPhase(job.key, 'running')
    // It stays pending through a pause, until the resumed transfer ends.
    const settle = (placed: boolean) => {
      following.delete(job.key)
      const current = useOnboardingStore
        .getState()
        .jobs.find((candidate) => candidate.key === job.key)
      // Removed meanwhile: nothing left to mark.
      if (current?.phase !== 'running') return
      useOnboardingStore
        .getState()
        .setJobPhase(job.key, placed ? 'done' : 'failed')
    }
    void startMediaJob(job).then(settle, (error: unknown) => {
      console.error('[onboarding] media job failed:', error)
      settle(false)
    })
  }, [phase, jobs, serviceHub, t])

  // The composer gets the model once it can answer, unless the user picked
  // one meanwhile (a cloud model, say). Once per model: emptying the composer
  // on purpose afterwards is left alone. The selection on screen when this
  // render happened is what counts, so a startup default the picker put in
  // the same moment does not keep the run's model out.
  const selectedRef = useRef<string | null>(null)
  useEffect(() => {
    if (phase !== 'handedOff' || !ready || selectedModel) return
    const key = `${ready.provider}:${ready.modelId}`
    if (selectedRef.current === key) return
    selectedRef.current = key
    useModelProvider
      .getState()
      .selectModelProvider(ready.provider, ready.modelId)
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider: ready.provider, model: ready.modelId })
    )
  }, [phase, ready, selectedModel])

  // A server handoff serves the run's model once it is ready, unless the
  // server already has a model of its own.
  useEffect(() => {
    if (phase !== 'handedOff' || !ready) return
    if (destination !== 'endpoint' && destination !== 'agents') return
    const server = useLocalApiServer.getState()
    if (server.defaultModelLocalApiServer) return
    server.setDefaultModelLocalApiServer({
      model: ready.modelId,
      provider: ready.provider,
    })
  }, [phase, destination, ready])

  // A failure takes the transfer's row out of the download store, and
  // `DownloadManagement` hears of it first: note where each running job
  // stands as it goes, and hand it to the job once it is interrupted, so the
  // strip and the picker still say how far it got. Once the transfer reports
  // again, its row is the job's figure once more.
  const lastTransferRef = useRef(new Map<string, JobTransfer>())
  useEffect(() => {
    const lastTransfer = lastTransferRef.current
    const note = () => {
      const { downloads } = useDownloadStore.getState()
      for (const job of useOnboardingStore.getState().jobs) {
        if (job.phase !== 'running') continue
        const row = downloads[job.taskId]
        if (!row || !(row.current > 0)) continue
        lastTransfer.set(job.taskId, {
          progress: row.progress,
          current: row.current,
          total: row.total,
        })
        if (job.stoppedAt) {
          useOnboardingStore
            .getState()
            .enqueue({ ...job, stoppedAt: undefined })
        }
      }
    }
    note()
    return useDownloadStore.subscribe(note)
  }, [])
  useEffect(() => {
    const lastTransfer = lastTransferRef.current
    const run = useOnboardingStore.getState()
    for (const job of run.jobs) {
      if (job.phase !== 'failed') continue
      const stopped = lastTransfer.get(job.taskId)
      if (!stopped) continue
      lastTransfer.delete(job.taskId)
      run.enqueue({ ...job, stoppedAt: { ...stopped, taskId: job.taskId } })
    }
  }, [jobs])

  // The panel follows the downloads after a handoff to the chat, and says the
  // model is ready once it is — also when it was before the handoff, as the
  // prototype does — until it is dismissed. The ready note is this session's
  // only if it saw the setup screen or a download: a relaunch with nothing
  // left to follow ends the run instead.
  const [seenInApp, setSeenInApp] = useState(phase === 'active')
  const panel = handoffPanelContent(
    { phase, destination, panelDismissed, jobs },
    { ready: !!ready, seenInApp }
  )
  const showPanel = panel !== null
  useEffect(() => {
    if (phase === 'active' || panel === 'downloads') setSeenInApp(true)
  }, [phase, panel])

  // Nothing of the run is left on screen: no download, no panel, no server
  // hint, and the chosen model (if any) can answer.
  const settled = queueSettled(jobs)
  useEffect(() => {
    if (
      phase === 'handedOff' &&
      settled &&
      !guide &&
      !showPanel &&
      (!choice || ready)
    ) {
      useOnboardingStore.getState().finish()
    }
  }, [phase, settled, guide, showPanel, choice, ready])

  return panel ? (
    <OnboardingHandoffPanel yieldsCorner={panel === 'ready'} />
  ) : null
}

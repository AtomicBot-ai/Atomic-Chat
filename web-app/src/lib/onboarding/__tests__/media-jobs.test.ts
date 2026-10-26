import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import {
  makeCatalog,
  makeFakeDiffusion,
  makeFilesFor,
  makeStatus,
  Q4_ID,
  Z_IMAGE,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { seedServiceHub } from '@/test/service-hub'
import type {
  DiffusionModelFile,
  DiffusionStatus,
} from '@/services/diffusion/types'

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  installEngine: vi.fn(),
  cancelDownload: vi.fn(),
  pauseDownload: vi.fn(),
}))

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  i18n: {
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key} ${Object.values(vars).join(' ')}` : key,
  },
  useTranslation: () => ({ t: (key: string) => key }),
}))
// The transfer and the core's install have tests of their own; here they are
// what the download store and the engine status make of them.
vi.mock('@/lib/diffusion/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/diffusion/models')>()),
  downloadArtifact: mocks.download,
}))
vi.mock('@/services/diffusion/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/diffusion/engine')>()),
  installDiffusionEngine: mocks.installEngine,
}))
vi.mock('@/lib/downloadCancellation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/downloadCancellation')>()),
  cancelDownload: mocks.cancelDownload,
}))
vi.mock('@/lib/downloadControls', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/downloadControls')>()),
  pauseDownload: mocks.pauseDownload,
}))

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { diffusionDownloadTaskId } from '@/lib/diffusion/models'
import { isPausableDownload } from '@/lib/downloadControls'
import { jobView, type OnboardingJob } from '@/lib/onboarding/jobs'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useOnboardingStore } from '@/stores/onboarding-store'

import { startMediaJob } from '../media-jobs'

const MODEL_TASK = diffusionDownloadTaskId(Q4_ID)
const ENGINE_TASK = 'diffusion-backend-master-849-d04e895-macos-arm64'
const MB = 1024 ** 2

const job: OnboardingJob = {
  key: 'z-image',
  kind: 'image',
  title: 'Z-Image Turbo',
  taskId: MODEL_TASK,
  artifactId: Q4_ID,
  totalBytes: 6_800_000_000,
  phase: 'running',
}

const core = {
  status: makeStatus() as DiffusionStatus,
  files: [] as DiffusionModelFile[],
}

const notInstalled = () => makeStatus({ install: { state: 'not-installed' } })

const queuedJob = () =>
  useOnboardingStore
    .getState()
    .jobs.find((candidate) => candidate.key === job.key)

const viewOf = (candidate: OnboardingJob) =>
  jobView(candidate, useDownloadStore.getState())

const onboardingErrors = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter(([message]) =>
    String(message).startsWith('[onboarding]')
  )

/** Lets the job reach whatever it waits on next. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('startMediaJob', () => {
  let errors: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    core.status = makeStatus()
    core.files = []
    seedServiceHub({
      diffusion: makeFakeDiffusion({
        getStatus: vi.fn(async () => core.status),
        listModelFiles: vi.fn(async () => core.files),
      }),
    })
    useDownloadStore.setState({ downloads: {}, pausedDownloads: new Set() })
    useGeneralSetting.setState({ huggingfaceToken: 'hf_test' })
    useImageGenerationStore.getState().reset()
    useImageGenerationStore.setState({
      catalog: makeCatalog(),
      status: core.status,
      hostBackendId: 'macos-arm64',
    })
    useOnboardingStore.getState().reset()
    useOnboardingStore.getState().begin('full', 'media')
    useOnboardingStore.getState().enqueue(job)
    // The transfer lands every file the plan asked for.
    mocks.download.mockImplementation(async () => {
      core.files = makeFilesFor(Z_IMAGE, 'q4_k_m')
    })
  })

  afterEach(() => {
    errors.mockRestore()
  })

  it('installs a missing engine with its progress on the strip, then downloads the model', async () => {
    core.status = notInstalled()
    useImageGenerationStore.setState({ status: core.status })
    const seen: Array<{
      job: OnboardingJob
      percent: number
      pausable: boolean
    }> = []
    mocks.installEngine.mockImplementation(async () => {
      const look = () => {
        const current = queuedJob()!
        seen.push({
          job: current,
          percent: viewOf(current).percent,
          pausable: isPausableDownload(current.taskId),
        })
      }
      look()
      useDownloadStore
        .getState()
        .updateProgress(ENGINE_TASK, 0.4, ENGINE_TASK, 40 * MB, 100 * MB)
      look()
      useDownloadStore.getState().removeDownload(ENGINE_TASK)
      core.status = makeStatus()
      return { build: { backend_id: 'macos-arm64' } }
    })

    await expect(startMediaJob(job)).resolves.toBe(true)

    // Before the core's first frame: the engine's title, nothing to pause.
    expect(seen[0].job).toMatchObject({
      title: 'onboarding-media:engineTitle Z-Image Turbo',
      totalBytes: undefined,
    })
    expect(seen[0].pausable).toBe(false)
    // Then the engine's own row, with its percent.
    expect(seen[1].job.taskId).toBe(ENGINE_TASK)
    expect(seen[1].percent).toBe(40)
    expect(seen[1].pausable).toBe(false)
    // And back to the model's row once installed.
    expect(queuedJob()).toEqual(job)
    expect(useImageGenerationStore.getState().status?.install.state).toBe(
      'installed'
    )
    expect(mocks.download).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'z-image' }),
      'q4_k_m',
      expect.objectContaining({ resume: true, hfToken: 'hf_test' })
    )
    // Re-listed, so the Images page sees the model.
    expect(
      useImageGenerationStore.getState().installedArtifacts
    ).toContainEqual(expect.objectContaining({ id: Q4_ID, complete: true }))
  })

  it('leaves an installed engine alone', async () => {
    await expect(startMediaJob(job)).resolves.toBe(true)

    expect(mocks.installEngine).not.toHaveBeenCalled()
    expect(queuedJob()).toEqual(job)
  })

  it('a failed download resolves false and is logged, with no toast of its own', async () => {
    mocks.download.mockRejectedValue(new Error('HTTP status 500'))

    await expect(startMediaJob(job)).resolves.toBe(false)

    expect(onboardingErrors(errors)).toHaveLength(1)
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    expect(useImageGenerationStore.getState().installedArtifacts).toEqual([])
  })

  it('a cancelled download resolves false quietly', async () => {
    mocks.download.mockRejectedValue(new Error('Download cancelled'))

    await expect(startMediaJob(job)).resolves.toBe(false)

    expect(onboardingErrors(errors)).toEqual([])
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('an engine that failed to install downloads nothing', async () => {
    core.status = notInstalled()
    useImageGenerationStore.setState({ status: core.status })
    mocks.installEngine.mockRejectedValue({
      code: 'ENGINE_INSTALL_FAILED',
      message: 'probe failed',
    })

    await expect(startMediaJob(job)).resolves.toBe(false)

    expect(mocks.download).not.toHaveBeenCalled()
    expect(onboardingErrors(errors)).toHaveLength(1)
    expect(queuedJob()).toEqual(job)
  })

  it('an engine install cancelled from the panel resolves false quietly', async () => {
    core.status = notInstalled()
    useImageGenerationStore.setState({ status: core.status })
    mocks.installEngine.mockRejectedValue({ code: 'CANCELLED', message: '' })

    await expect(startMediaJob(job)).resolves.toBe(false)

    expect(mocks.download).not.toHaveBeenCalled()
    expect(onboardingErrors(errors)).toEqual([])
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('a paused download holds the job, progress kept, until the resumed transfer lands', async () => {
    mocks.download.mockImplementation(async () => {
      const store = useDownloadStore.getState()
      store.updateProgress(MODEL_TASK, 0.3, MODEL_TASK, 30 * MB, 100 * MB)
      // Pause: the row stays, the transfer stops.
      store.markPausedDownload(MODEL_TASK)
      throw new Error('Download cancelled')
    })
    let outcome: boolean | undefined
    const running = startMediaJob(job).then((value) => (outcome = value))
    await settle()

    expect(outcome).toBeUndefined()
    expect(viewOf(queuedJob()!)).toMatchObject({ state: 'paused', percent: 30 })

    // Resume runs the transfer elsewhere (the strip's or the panel's), which
    // closes the row when the files are in.
    useDownloadStore.getState().clearPausedDownload(MODEL_TASK)
    await settle()
    expect(outcome).toBeUndefined()
    core.files = makeFilesFor(Z_IMAGE, 'q4_k_m')
    useDownloadStore.getState().removeDownload(MODEL_TASK)
    await running

    expect(outcome).toBe(true)
    expect(mocks.download).toHaveBeenCalledTimes(1)
  })

  it('follows a transfer of the same model already under way instead of starting another', async () => {
    useDownloadStore
      .getState()
      .updateProgress(MODEL_TASK, 0.5, MODEL_TASK, 50 * MB, 100 * MB)
    let outcome: boolean | undefined
    const running = startMediaJob(job).then((value) => (outcome = value))
    await settle()
    expect(outcome).toBeUndefined()

    // That transfer fails: its row closes with nothing on disk.
    useDownloadStore.getState().removeDownload(MODEL_TASK)
    await running

    expect(outcome).toBe(false)
    expect(mocks.download).not.toHaveBeenCalled()
  })

  describe('a chat download chosen while it runs', () => {
    const chat: OnboardingJob = {
      key: 'chat',
      kind: 'chat',
      title: 'Qwen3.5 4B',
      taskId: 'Qwen3.5-4B-Q4_K_M',
      phase: 'running',
    }
    const chooseChat = () => useOnboardingStore.getState().enqueue(chat)
    const finishChat = () =>
      useOnboardingStore.getState().setJobPhase(chat.key, 'done')

    it('pauses its model file for the chat model, then picks it up where it stopped', async () => {
      let stopTransfer: (error: Error) => void = () => undefined
      mocks.download.mockImplementationOnce(() => {
        useDownloadStore
          .getState()
          .updateProgress(MODEL_TASK, 0.3, MODEL_TASK, 30 * MB, 100 * MB)
        return new Promise((_resolve, reject) => {
          stopTransfer = reject
        })
      })
      // What Pause does to a model file: the row stays, the transfer stops.
      mocks.pauseDownload.mockImplementation(({ id }: { id: string }) => {
        useDownloadStore.getState().markPausedDownload(id)
        stopTransfer(new Error('Download cancelled'))
      })
      let outcome: boolean | undefined
      const running = startMediaJob(job).then((value) => (outcome = value))
      await settle()

      chooseChat()
      await settle()

      expect(mocks.pauseDownload).toHaveBeenCalledWith(
        { id: MODEL_TASK, name: MODEL_TASK },
        expect.anything()
      )
      expect(queuedJob()?.phase).toBe('queued')
      expect(useOnboardingStore.getState().jobs[0].key).toBe(chat.key)
      expect(outcome).toBeUndefined()

      // The resumed transfer lands the files and closes the row.
      mocks.download.mockImplementationOnce(async () => {
        core.files = makeFilesFor(Z_IMAGE, 'q4_k_m')
        useDownloadStore.getState().removeDownload(MODEL_TASK)
      })
      finishChat()
      await running

      expect(queuedJob()?.phase).toBe('running')
      expect(useDownloadStore.getState().pausedDownloads.has(MODEL_TASK)).toBe(
        false
      )
      expect(mocks.download).toHaveBeenCalledTimes(2)
      expect(mocks.download).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'z-image' }),
        'q4_k_m',
        expect.objectContaining({ resume: true })
      )
      expect(outcome).toBe(true)
      expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    })

    it("leaves a pause of the user's own to them", async () => {
      mocks.download.mockImplementation(() => {
        const store = useDownloadStore.getState()
        store.updateProgress(MODEL_TASK, 0.3, MODEL_TASK, 30 * MB, 100 * MB)
        store.markPausedDownload(MODEL_TASK)
        return Promise.reject(new Error('Download cancelled'))
      })
      void startMediaJob(job)
      await settle()

      chooseChat()
      finishChat()
      await settle()

      expect(mocks.pauseDownload).not.toHaveBeenCalled()
      expect(mocks.download).toHaveBeenCalledTimes(1)
      expect(useDownloadStore.getState().pausedDownloads.has(MODEL_TASK)).toBe(
        true
      )
    })

    it('waits for the chat model after the engine install before downloading its model', async () => {
      core.status = notInstalled()
      useImageGenerationStore.setState({ status: core.status })
      mocks.installEngine.mockImplementation(async () => {
        // Chosen while the engine, which cannot be paused, installs.
        chooseChat()
        core.status = makeStatus()
        return { build: { backend_id: 'macos-arm64' } }
      })
      let outcome: boolean | undefined
      const running = startMediaJob(job).then((value) => (outcome = value))
      await settle()

      expect(mocks.download).not.toHaveBeenCalled()
      expect(queuedJob()?.phase).toBe('queued')

      finishChat()
      await running

      expect(mocks.download).toHaveBeenCalledTimes(1)
      expect(queuedJob()?.phase).toBe('running')
      expect(outcome).toBe(true)
    })
  })

  it('taking the job off the queue stops its download', async () => {
    let stopTransfer: (error: Error) => void = () => undefined
    mocks.download.mockImplementation(() => {
      useDownloadStore
        .getState()
        .updateProgress(MODEL_TASK, 0.1, MODEL_TASK, 10 * MB, 100 * MB)
      return new Promise((_resolve, reject) => {
        stopTransfer = reject
      })
    })
    // What the panel's Cancel does: the row closes, the transfer stops.
    mocks.cancelDownload.mockImplementation(({ id }: { id: string }) => {
      useDownloadStore.getState().removeDownload(id)
      stopTransfer(new Error('Download cancelled'))
    })
    const running = startMediaJob(job)
    await settle()

    useOnboardingStore.getState().dequeue(job.key)

    await expect(running).resolves.toBe(false)
    expect(mocks.cancelDownload).toHaveBeenCalledWith(
      { id: MODEL_TASK, name: MODEL_TASK },
      expect.anything()
    )
    expect(useDownloadStore.getState().downloads[MODEL_TASK]).toBeUndefined()
    expect(onboardingErrors(errors)).toEqual([])
  })

  it('a job taken off the queue during the engine install is not downloaded', async () => {
    core.status = notInstalled()
    useImageGenerationStore.setState({ status: core.status })
    mocks.installEngine.mockImplementation(async () => {
      useOnboardingStore.getState().dequeue(job.key)
      core.status = makeStatus()
      return { build: { backend_id: 'macos-arm64' } }
    })

    await expect(startMediaJob(job)).resolves.toBe(false)

    expect(mocks.download).not.toHaveBeenCalled()
    expect(useOnboardingStore.getState().jobs).toEqual([])
  })

  it('puts back a job that a relaunch left pointing at the engine', async () => {
    useOnboardingStore.getState().enqueue({
      ...job,
      taskId: ENGINE_TASK,
      title: 'onboarding-media:engineTitle Z-Image Turbo',
    })

    await expect(startMediaJob(queuedJob()!)).resolves.toBe(true)

    expect(queuedJob()).toMatchObject({
      taskId: MODEL_TASK,
      title: 'Z-Image Turbo',
    })
  })
})

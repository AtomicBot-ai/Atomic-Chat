import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { DownloadEvent } from '@janhq/core'

import { localStorageKey } from '@/constants/localStorage'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { OnboardingJob } from '@/lib/onboarding/jobs'
import {
  useOnboardingStore,
  type OnboardingDestination,
} from '@/stores/onboarding-store'
import { useUpdateBannerSlots } from '@/stores/update-banner-store'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  startMediaJob: vi.fn(),
  resumeDownload: vi.fn(),
}))

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key} ${Object.values(vars).join(' ')}` : key,
  }),
}))
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => ({}) }))
// Another change implements the image/video download; the runtime only
// relies on its contract: true once the file is in place, false otherwise.
vi.mock('@/lib/onboarding/media-jobs', () => ({
  startMediaJob: mocks.startMediaJob,
}))
vi.mock('@/lib/downloadResume', () => ({
  resumeDownload: mocks.resumeDownload,
}))

import { OnboardingRuntime } from '../OnboardingRuntime'

// The download extensions report through `core.events`; a plain emitter
// stands in for it.
const handlers = new Map<string, Set<(payload: unknown) => void>>()
const emit = (event: string, payload: unknown) =>
  act(() => handlers.get(event)?.forEach((handler) => handler(payload)))

const chat: OnboardingJob = {
  key: 'chat',
  kind: 'chat',
  title: 'Qwen3.5 4B',
  taskId: 'Qwen3.5-4B-Q4_K_M',
  phase: 'running',
}
const image: OnboardingJob = {
  key: 'z-image',
  kind: 'image',
  title: 'Z-Image Turbo',
  taskId: 'diffusion-model-z-image_q4',
  phase: 'queued',
}
const video: OnboardingJob = {
  key: 'ltx-2',
  kind: 'video',
  title: 'LTX-2',
  taskId: 'diffusion-model-ltx-2_q4',
  phase: 'queued',
}
const done = (job: OnboardingJob): OnboardingJob => ({ ...job, phase: 'done' })

const cloud = {
  provider: 'openai',
  active: true,
  api_key: 'configured',
  models: [{ id: 'gpt-5' }],
}
const local = (ids: string[] = []) => ({
  provider: 'llamacpp-upstream',
  active: true,
  models: ids.map((id) => ({ id })),
})
const setProviders = (providers: unknown[]) =>
  act(() => {
    useModelProvider.setState({ providers } as never)
  })
const landChatModel = () => setProviders([local([chat.taskId]), cloud])

function startRun(
  jobs: OnboardingJob[],
  {
    destination = 'chat',
    handedOff = true,
  }: { destination?: OnboardingDestination; handedOff?: boolean } = {}
) {
  const store = useOnboardingStore.getState()
  store.begin('full', 'model')
  store.choose({
    source: 'download',
    provider: 'llamacpp-upstream',
    modelId: chat.taskId,
    title: chat.title,
    matchIds: [chat.taskId],
  })
  jobs.forEach((job) => store.enqueue(job))
  if (handedOff) store.handOff(destination)
}

/** The chat model's download, under way in the download store. */
const downloadingChat = () =>
  useDownloadStore.setState({
    downloads: {
      [chat.taskId]: {
        id: chat.taskId,
        name: chat.taskId,
        progress: 0.4,
        current: 40,
        total: 100,
      },
    },
    resumeParams: {
      [chat.taskId]: { modelPath: 'https://huggingface.co/q/q4.gguf' },
    },
  } as never)

const phaseOf = (key: string) =>
  useOnboardingStore.getState().jobs.find((job) => job.key === key)?.phase
const jobOf = (key: string) =>
  useOnboardingStore.getState().jobs.find((job) => job.key === key)

const GB = 1024 ** 3
/** The chat model's transfer at `progress` of 2.7 GB. */
const chatRow = (progress: number) => ({
  id: chat.taskId,
  name: chat.taskId,
  progress,
  current: progress * 2.7 * GB,
  total: 2.7 * GB,
})

/** An update offer holding the bottom-right corner, or letting it go. */
const claimUpdateCorner = (claimed: boolean) =>
  act(() => useUpdateBannerSlots.getState().setSlotVisible('app', claimed))

/** `startMediaJob` calls still waiting to settle, oldest first. */
let pendingMedia: Array<(placed: boolean) => void> = []
const settleMedia = (placed: boolean) =>
  act(async () => {
    pendingMedia.shift()?.(placed)
  })

describe('OnboardingRuntime', () => {
  beforeAll(() => {
    ;(globalThis as unknown as { core: Record<string, unknown> }).core.events =
      {
        on: (event: string, handler: (payload: unknown) => void) => {
          if (!handlers.has(event)) handlers.set(event, new Set())
          handlers.get(event)!.add(handler)
        },
        off: (event: string, handler: (payload: unknown) => void) =>
          handlers.get(event)?.delete(handler),
        emit: () => {},
      }
  })

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    pendingMedia = []
    mocks.startMediaJob.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          pendingMedia.push(resolve)
        })
    )
    useOnboardingStore.getState().reset()
    useModelProvider.setState({
      providers: [cloud],
      selectedProvider: '',
      selectedModel: null,
    } as never)
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      pausedDownloads: new Set(),
      resumableDownloads: new Set(),
      resumeParams: {},
    })
    useLocalApiServer.setState({ defaultModelLocalApiServer: null })
    useUpdateBannerSlots.setState({
      claimed: { app: false, engine: false },
    })
  })

  afterEach(async () => {
    // Settle what a test left running, so no job is still followed.
    await act(async () => {
      pendingMedia.forEach((resolve) => resolve(false))
    })
  })

  describe('the queue', () => {
    it('runs the image and video jobs after the chat model, one at a time', async () => {
      startRun([done(chat), image, video])
      landChatModel()
      render(<OnboardingRuntime />)

      expect(mocks.startMediaJob).toHaveBeenCalledTimes(1)
      expect(mocks.startMediaJob).toHaveBeenCalledWith(
        expect.objectContaining({ key: image.key })
      )
      expect(phaseOf(image.key)).toBe('running')
      expect(phaseOf(video.key)).toBe('queued')

      await settleMedia(true)

      expect(phaseOf(image.key)).toBe('done')
      expect(phaseOf(video.key)).toBe('running')
      expect(mocks.startMediaJob).toHaveBeenLastCalledWith(
        expect.objectContaining({ key: video.key })
      )

      await settleMedia(true)

      expect(phaseOf(video.key)).toBe('done')
    })

    it('keeps going during setup, before any handoff', () => {
      startRun([done(chat), image], { handedOff: false })
      landChatModel()
      render(<OnboardingRuntime />)

      expect(phaseOf(image.key)).toBe('running')
      expect(screen.queryByTestId('onboarding-handoff')).not.toBeInTheDocument()
    })

    it('holds the queue behind a paused chat download', () => {
      startRun([chat, image])
      downloadingChat()
      useDownloadStore.setState({ pausedDownloads: new Set([chat.taskId]) })
      render(<OnboardingRuntime />)

      expect(phaseOf(chat.key)).toBe('running')
      expect(phaseOf(image.key)).toBe('queued')
      expect(mocks.startMediaJob).not.toHaveBeenCalled()
    })

    it('holds the queue behind an interrupted job until it is retried', () => {
      startRun([{ ...chat, phase: 'failed' }, image])
      render(<OnboardingRuntime />)

      expect(phaseOf(image.key)).toBe('queued')
      expect(mocks.startMediaJob).not.toHaveBeenCalled()
      expect(
        screen.getByRole('button', { name: 'onboarding-handoff:retryLabel' })
      ).toBeInTheDocument()
    })

    it('marks an image job interrupted when its download fails', async () => {
      startRun([done(chat), image])
      landChatModel()
      render(<OnboardingRuntime />)

      await settleMedia(false)

      expect(phaseOf(image.key)).toBe('failed')
    })

    it('keeps following an image job through a pause and its Resume', async () => {
      startRun([done(chat), image])
      landChatModel()
      render(<OnboardingRuntime />)
      act(() => {
        useDownloadStore.setState({ pausedDownloads: new Set([image.taskId]) })
      })

      // `startMediaJob` stays pending while the transfer is paused.
      expect(phaseOf(image.key)).toBe('running')
      fireEvent.click(
        screen.getByRole('button', { name: 'onboarding:download.resume' })
      )
      expect(mocks.resumeDownload).toHaveBeenCalledWith(
        { id: image.taskId, name: image.taskId },
        expect.anything()
      )
      expect(mocks.startMediaJob).toHaveBeenCalledTimes(1)

      await settleMedia(true)

      expect(phaseOf(image.key)).toBe('done')
    })

    it('leaves alone a job removed while it ran', async () => {
      startRun([done(chat), image])
      landChatModel()
      render(<OnboardingRuntime />)
      act(() => useOnboardingStore.getState().dequeue(image.key))

      await settleMedia(false)

      expect(useOnboardingStore.getState().jobs.map((job) => job.key)).toEqual([
        chat.key,
      ])
    })

    it('starts an interrupted image job again on Retry', async () => {
      startRun([done(chat), image])
      landChatModel()
      render(<OnboardingRuntime />)
      await settleMedia(false)
      expect(phaseOf(image.key)).toBe('failed')

      fireEvent.click(
        screen.getByRole('button', { name: 'onboarding-handoff:retryLabel' })
      )

      expect(phaseOf(image.key)).toBe('running')
      expect(mocks.startMediaJob).toHaveBeenCalledTimes(2)
      await settleMedia(true)
      expect(phaseOf(image.key)).toBe('done')
    })

    it('follows a job by its key while it shows the engine download', async () => {
      startRun([done(chat), image])
      landChatModel()
      render(<OnboardingRuntime />)
      // What `startMediaJob` does while it installs the image engine.
      act(() =>
        useOnboardingStore.getState().enqueue({
          ...image,
          taskId: 'diffusion-backend-metal',
          title: 'Image engine',
          phase: 'running',
        })
      )
      expect(screen.getByTestId('onboarding-handoff')).toHaveTextContent(
        'Image engine'
      )

      await settleMedia(true)

      expect(phaseOf(image.key)).toBe('done')
    })

    it('starts again an image job the last session left running', async () => {
      startRun([done(chat), { ...image, phase: 'running' }])
      landChatModel()
      render(<OnboardingRuntime />)

      expect(mocks.startMediaJob).toHaveBeenCalledTimes(1)
      await settleMedia(true)
      expect(phaseOf(image.key)).toBe('done')
    })

    it('marks interrupted a chat download the last session left with nothing to resume', () => {
      startRun([chat])
      render(<OnboardingRuntime />)

      expect(phaseOf(chat.key)).toBe('failed')
    })
  })

  describe('the chat download', () => {
    it('is done once the model lands in the library', () => {
      startRun([chat], { handedOff: false })
      downloadingChat()
      render(<OnboardingRuntime />)

      landChatModel()

      expect(phaseOf(chat.key)).toBe('done')
    })

    it('is interrupted by a failure, and Retry resumes it from where it stopped', () => {
      startRun([chat])
      downloadingChat()
      render(<OnboardingRuntime />)

      emit(DownloadEvent.onFileDownloadError, {
        modelId: chat.taskId,
        error: 'HTTP status 500',
      })
      // What DownloadManagement does with a failed download.
      act(() => {
        const store = useDownloadStore.getState()
        store.clearResumeParams(chat.taskId)
        store.removeDownload(chat.taskId)
      })

      expect(phaseOf(chat.key)).toBe('failed')

      fireEvent.click(
        screen.getByRole('button', { name: 'onboarding-handoff:retryLabel' })
      )

      expect(phaseOf(chat.key)).toBe('running')
      expect(useDownloadStore.getState().resumeParams[chat.taskId]).toEqual({
        modelPath: 'https://huggingface.co/q/q4.gguf',
      })
      expect(mocks.resumeDownload).toHaveBeenCalledWith(
        { id: chat.taskId, name: chat.taskId },
        expect.anything()
      )
    })

    it('keeps how far it got when it is interrupted, through the Retry', () => {
      startRun([chat])
      downloadingChat()
      act(() => {
        useDownloadStore.setState({
          downloads: { [chat.taskId]: chatRow(0.4137) },
        } as never)
      })
      render(<OnboardingRuntime />)

      // DownloadManagement hears of the failure first and drops the row.
      act(() => {
        const store = useDownloadStore.getState()
        store.clearResumeParams(chat.taskId)
        store.removeDownload(chat.taskId)
      })
      emit(DownloadEvent.onFileDownloadError, {
        modelId: chat.taskId,
        error: 'HTTP status 500',
      })

      const panel = screen.getByTestId('onboarding-handoff')
      const { progress, current, total } = chatRow(0.4137)
      expect(jobOf(chat.key)?.stoppedAt).toEqual({
        taskId: chat.taskId,
        progress,
        current,
        total,
      })
      expect(panel).toHaveTextContent('41%')
      expect(panel).toHaveTextContent(
        'onboarding:download.interrupted · 1.12 / 2.70 GB'
      )

      fireEvent.click(
        screen.getByRole('button', { name: 'onboarding-handoff:retryLabel' })
      )

      // Resuming from the bytes on disk: no step back to 0%.
      expect(phaseOf(chat.key)).toBe('running')
      expect(panel).toHaveTextContent('41%')

      act(() => {
        useDownloadStore.setState({
          downloads: { [chat.taskId]: chatRow(0.45) },
        } as never)
      })

      expect(jobOf(chat.key)?.stoppedAt).toBeUndefined()
      expect(panel).toHaveTextContent('45%')
    })

    it('is interrupted when the downloaded file fails its check', () => {
      startRun([chat])
      downloadingChat()
      render(<OnboardingRuntime />)

      emit(DownloadEvent.onModelValidationFailed, { modelId: chat.taskId })

      expect(phaseOf(chat.key)).toBe('failed')
    })

    it('stays where it is when the user pauses it', () => {
      startRun([chat])
      downloadingChat()
      useDownloadStore.setState({ pausedDownloads: new Set([chat.taskId]) })
      render(<OnboardingRuntime />)

      emit(DownloadEvent.onFileDownloadStopped, { modelId: chat.taskId })
      emit(DownloadEvent.onFileDownloadError, {
        modelId: chat.taskId,
        error: 'download aborted',
      })

      expect(phaseOf(chat.key)).toBe('running')
    })

    it('is let go when the user cancels it, and the queue moves on', () => {
      startRun([chat, image])
      downloadingChat()
      render(<OnboardingRuntime />)

      emit(DownloadEvent.onFileDownloadStopped, { modelId: chat.taskId })

      expect(phaseOf(chat.key)).toBeUndefined()
      expect(phaseOf(image.key)).toBe('running')
    })

    it('ignores other downloads', () => {
      startRun([chat])
      downloadingChat()
      render(<OnboardingRuntime />)

      emit(DownloadEvent.onFileDownloadError, {
        modelId: 'Other-Model-Q4_K_M',
        error: 'HTTP status 500',
      })

      expect(phaseOf(chat.key)).toBe('running')
    })
  })

  describe('after the handoff', () => {
    it('puts the model in the empty composer once it lands', () => {
      startRun([chat])
      downloadingChat()
      render(<OnboardingRuntime />)

      landChatModel()

      expect(useModelProvider.getState()).toMatchObject({
        selectedProvider: 'llamacpp-upstream',
        selectedModel: expect.objectContaining({ id: chat.taskId }),
      })
      expect(
        JSON.parse(localStorage.getItem(localStorageKey.lastUsedModel)!)
      ).toEqual({ provider: 'llamacpp-upstream', model: chat.taskId })
    })

    it('never replaces a model the user picked meanwhile', () => {
      startRun([chat])
      downloadingChat()
      useModelProvider.setState({
        selectedProvider: 'openai',
        selectedModel: cloud.models[0],
      } as never)
      render(<OnboardingRuntime />)

      landChatModel()

      expect(useModelProvider.getState().selectedModel?.id).toBe('gpt-5')
      expect(localStorage.getItem(localStorageKey.lastUsedModel)).toBeNull()
    })

    it('leaves the composer alone while setup is still on screen', () => {
      startRun([chat], { handedOff: false })
      downloadingChat()
      render(<OnboardingRuntime />)

      landChatModel()

      expect(useModelProvider.getState().selectedModel).toBeNull()
    })

    it('serves the model from the Local API Server after a server handoff', () => {
      startRun([chat], { destination: 'endpoint' })
      downloadingChat()
      render(<OnboardingRuntime />)

      landChatModel()

      expect(useLocalApiServer.getState().defaultModelLocalApiServer).toEqual({
        model: chat.taskId,
        provider: 'llamacpp-upstream',
      })
      // The server pages still show their hints: the run is not over.
      expect(useOnboardingStore.getState().phase).toBe('handedOff')
    })

    it('keeps a model the server already serves', () => {
      startRun([chat], { destination: 'agents' })
      downloadingChat()
      useLocalApiServer.setState({
        defaultModelLocalApiServer: { model: 'gpt-5', provider: 'openai' },
      })
      render(<OnboardingRuntime />)

      landChatModel()

      expect(useLocalApiServer.getState().defaultModelLocalApiServer).toEqual({
        model: 'gpt-5',
        provider: 'openai',
      })
    })
  })

  describe('the handoff panel and the end of the run', () => {
    it('follows the download, says the model is ready, and the run ends on Dismiss', () => {
      startRun([chat])
      downloadingChat()
      render(<OnboardingRuntime />)

      expect(screen.getByTestId('onboarding-handoff')).toHaveTextContent(
        chat.title
      )

      landChatModel()

      expect(
        screen.getByText('onboarding:download.ready Qwen3.5 4B')
      ).toBeInTheDocument()
      expect(useOnboardingStore.getState().phase).toBe('handedOff')

      fireEvent.click(
        screen.getByRole('button', { name: 'onboarding-handoff:panel.dismiss' })
      )

      expect(screen.queryByTestId('onboarding-handoff')).not.toBeInTheDocument()
      expect(useOnboardingStore.getState().phase).toBe('finished')
    })

    it.each([
      ['finished downloading during setup', [done(chat)]],
      ['was downloaded already', []],
    ])(
      'says the model is ready when it %s, until Dismiss',
      (_, jobs: OnboardingJob[]) => {
        startRun(jobs, { handedOff: false })
        landChatModel()
        render(<OnboardingRuntime />)
        expect(
          screen.queryByTestId('onboarding-handoff')
        ).not.toBeInTheDocument()

        act(() => useOnboardingStore.getState().handOff('chat'))

        expect(screen.getByTestId('onboarding-handoff')).toHaveTextContent(
          'onboarding:download.ready Qwen3.5 4B'
        )
        expect(useOnboardingStore.getState().phase).toBe('handedOff')

        fireEvent.click(
          screen.getByRole('button', {
            name: 'onboarding-handoff:panel.dismiss',
          })
        )

        expect(
          screen.queryByTestId('onboarding-handoff')
        ).not.toBeInTheDocument()
        expect(useOnboardingStore.getState().phase).toBe('finished')
      }
    )

    it('ends at the next launch, without the panel, a run left with nothing to follow', () => {
      // Handed off and never dismissed in an earlier session.
      startRun([done(chat)])
      landChatModel()
      render(<OnboardingRuntime />)

      expect(screen.queryByTestId('onboarding-handoff')).not.toBeInTheDocument()
      expect(useOnboardingStore.getState().phase).toBe('finished')
    })

    // As in the prototype, after Skip setup or a cloud-only run too.
    it('can dismiss an empty handoff panel', () => {
      useOnboardingStore.getState().begin('full', 'welcome')
      render(<OnboardingRuntime />)

      act(() => useOnboardingStore.getState().handOff('chat'))

      const panel = screen.getByTestId('onboarding-handoff')
      expect(panel).not.toHaveTextContent(
        'onboarding-handoff:panel.backToSetup'
      )
      expect(
        screen.queryByRole('region', { name: 'onboarding:download.label' })
      ).not.toBeInTheDocument()
      expect(useOnboardingStore.getState().phase).toBe('handedOff')

      fireEvent.click(
        screen.getByRole('button', { name: 'onboarding-handoff:panel.dismiss' })
      )

      expect(screen.queryByTestId('onboarding-handoff')).not.toBeInTheDocument()
      expect(useOnboardingStore.getState().phase).toBe('finished')
    })

    it('ends at the next launch a run handed off with nothing at all', () => {
      useOnboardingStore.getState().begin('full', 'welcome')
      useOnboardingStore.getState().handOff('chat')
      render(<OnboardingRuntime />)

      expect(screen.queryByTestId('onboarding-handoff')).not.toBeInTheDocument()
      expect(useOnboardingStore.getState().phase).toBe('finished')
    })

    it('leaves the corner to an update banner while it only says the model is ready', () => {
      startRun([done(chat)], { handedOff: false })
      landChatModel()
      render(<OnboardingRuntime />)
      claimUpdateCorner(true)
      act(() => useOnboardingStore.getState().handOff('chat'))

      expect(screen.queryByTestId('onboarding-handoff')).not.toBeInTheDocument()
      // Still owed: the run waits for it.
      expect(useOnboardingStore.getState().phase).toBe('handedOff')

      claimUpdateCorner(false)

      expect(screen.getByTestId('onboarding-handoff')).toHaveTextContent(
        'onboarding:download.ready Qwen3.5 4B'
      )
    })

    it('keeps following the downloads under an update banner', () => {
      startRun([chat])
      downloadingChat()
      claimUpdateCorner(true)
      render(<OnboardingRuntime />)

      expect(screen.getByTestId('onboarding-handoff')).toHaveTextContent(
        chat.title
      )
    })

    it('waits for the downloads after the panel is dismissed', async () => {
      startRun([done(chat), image])
      landChatModel()
      render(<OnboardingRuntime />)

      fireEvent.click(
        screen.getByRole('button', { name: 'onboarding-handoff:panel.dismiss' })
      )
      expect(useOnboardingStore.getState().phase).toBe('handedOff')

      await settleMedia(true)

      expect(useOnboardingStore.getState().phase).toBe('finished')
    })

    it('waits for the server hints to be over', () => {
      startRun([done(chat)], { destination: 'agents' })
      landChatModel()
      render(<OnboardingRuntime />)

      expect(useOnboardingStore.getState().phase).toBe('handedOff')

      act(() => useOnboardingStore.getState().setGuide(null))

      expect(useOnboardingStore.getState().phase).toBe('finished')
    })

    it('shows no panel after a server handoff', () => {
      startRun([chat], { destination: 'endpoint' })
      downloadingChat()
      render(<OnboardingRuntime />)

      expect(screen.queryByTestId('onboarding-handoff')).not.toBeInTheDocument()
    })
  })
})
